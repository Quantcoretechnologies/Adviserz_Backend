import { randomUUID } from 'node:crypto';
import { Op, type Transaction } from 'sequelize';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { sequelize } from '../../db/sequelize.js';
import { AppError } from '../../common/errors/AppError.js';
import { ErrorCode } from '../../common/errors/errorCodes.js';
import type { RequestContext } from '../../common/http/requestContext.js';
import {
  generateNumericCode,
  generateOpaqueToken,
  hmacSha256Hex,
  safeEqualHex,
  sha256Hex,
} from '../../common/utils/crypto.js';
import { VerificationRequest } from '../../models/index.js';
import type { VerificationChannel, VerificationPurpose } from '../../models/enums.js';
import { recordAudit, recordAuditIndependently } from '../audit/audit.service.js';
import { AuditAction } from '../audit/auditActions.js';
import { getOtpSender } from '../notifications/otpSender.js';

export interface OtpIssued {
  verificationId: string;
  channel: VerificationChannel;
  expiresAt: Date;
  resendAvailableAt: Date;
}

export interface VerificationTokenIssued {
  verificationToken: string;
  expiresAt: Date;
}

/** The OTP is bound to its row id, so a code is useless for any other request. */
function otpDigest(verificationId: string, code: string): string {
  return hmacSha256Hex(env.OTP_HMAC_SECRET, `${verificationId}:${code}`);
}

const SECOND = 1000;
const HOUR = 60 * 60 * SECOND;

/**
 * Issue an OTP for (purpose, channel, destination).
 *
 * Phase 1 (transaction): a transaction-scoped advisory lock serialises
 * concurrent requests for the same destination so the cooldown and hourly cap
 * cannot be bypassed by parallel calls, and the new request row is committed.
 *
 * Phase 2 (after commit): the code is delivered. Delivery happens only once
 * the row is durably stored, so a user can never receive a code the database
 * does not know about, and no lock is held during the provider's network call.
 * - Delivery succeeds: earlier unconsumed requests are invalidated, so only
 *   the newest code (and any token derived from it) is valid.
 * - Delivery fails: the undelivered row is deleted — it does not count towards
 *   the cooldown or hourly cap, and earlier codes stay valid.
 */
export async function issueOtp(params: {
  purpose: VerificationPurpose;
  channel: VerificationChannel;
  destination: string;
  userId?: string | null;
  context: RequestContext;
}): Promise<OtpIssued> {
  const { purpose, channel, destination, context } = params;
  const sender = getOtpSender(channel);
  const code = sender.usesStaticCode ? env.STATIC_OTP_CODE : generateNumericCode(6);

  const issued = await sequelize.transaction(async (transaction): Promise<OtpIssued> => {
    await sequelize.query('SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))', {
      replacements: { key: `otp:${purpose}:${channel}:${destination}` },
      transaction,
    });

    const now = new Date();
    const scope = { purpose, channel, destination };

    const latest = await VerificationRequest.findOne({
      where: scope,
      order: [['createdAt', 'DESC']],
      transaction,
    });
    if (latest) {
      const resendAt = new Date(latest.createdAt.getTime() + env.OTP_RESEND_COOLDOWN_SECONDS * SECOND);
      if (resendAt > now) {
        throw AppError.tooManyRequests('Please wait before requesting another code', ErrorCode.OTP_RESEND_TOO_SOON, [
          { message: 'Resend cooldown active', retryAfterSeconds: Math.ceil((resendAt.getTime() - now.getTime()) / SECOND) },
        ]);
      }
    }

    const sentLastHour = await VerificationRequest.count({
      where: { ...scope, createdAt: { [Op.gt]: new Date(now.getTime() - HOUR) } },
      transaction,
    });
    if (sentLastHour >= env.OTP_MAX_SENDS_PER_HOUR) {
      throw AppError.tooManyRequests(
        'Too many codes requested. Please try again later',
        ErrorCode.OTP_SEND_LIMIT_REACHED,
      );
    }

    const id = randomUUID();
    const expiresAt = new Date(now.getTime() + env.OTP_TTL_SECONDS * SECOND);
    await VerificationRequest.create(
      {
        id,
        purpose,
        channel,
        destination,
        userId: params.userId ?? null,
        otpHash: otpDigest(id, code),
        otpExpiresAt: expiresAt,
        maxAttempts: env.OTP_MAX_ATTEMPTS,
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
      },
      { transaction },
    );

    return {
      verificationId: id,
      channel,
      expiresAt,
      resendAvailableAt: new Date(now.getTime() + env.OTP_RESEND_COOLDOWN_SECONDS * SECOND),
    };
  });

  const auditBase = {
    actor: params.userId ? { type: 'user' as const, id: params.userId } : { type: 'anonymous' as const },
    entityType: 'verification_request',
    entityId: issued.verificationId,
    subjectUserId: params.userId ?? null,
    context,
  };

  try {
    await sender.send({ channel, destination, code, purpose, ttlSeconds: env.OTP_TTL_SECONDS });
  } catch (error) {
    logger.error({ err: error, channel, purpose }, 'OTP delivery failed');
    await VerificationRequest.destroy({ where: { id: issued.verificationId } }).catch((cleanupError: unknown) =>
      logger.error({ err: cleanupError, verificationId: issued.verificationId }, 'Failed to remove undelivered OTP'),
    );
    await recordAuditIndependently({
      ...auditBase,
      action: AuditAction.OTP_DELIVERY_FAILED,
      severity: 'warning',
      outcome: 'failure',
      metadata: { purpose, channel },
    });
    throw new AppError(502, ErrorCode.OTP_DELIVERY_FAILED, 'Could not deliver the verification code. Please try again');
  }

  // Only now that the new code has reached the user are older codes retired,
  // so a delivery failure never leaves the user without a working code.
  try {
    await VerificationRequest.update(
      { invalidatedAt: new Date() },
      {
        where: {
          purpose,
          channel,
          destination,
          consumedAt: null,
          invalidatedAt: null,
          id: { [Op.ne]: issued.verificationId },
        },
      },
    );
  } catch (error) {
    // The new code is valid regardless; older codes simply expire on their own.
    logger.error({ err: error, verificationId: issued.verificationId }, 'Failed to retire previous OTPs');
  }

  await recordAuditIndependently({ ...auditBase, action: AuditAction.OTP_SENT, metadata: { purpose, channel } });
  return issued;
}

type VerifyOutcome =
  | { ok: true; issued: VerificationTokenIssued; request: VerificationRequest }
  | { ok: false; error: AppError; request: VerificationRequest | null };

/**
 * Check an OTP. On success the request is marked verified and a single-use,
 * short-lived verification token is returned (its hash is stored). Failed
 * attempts are committed even though the call throws, so the attempt limit
 * holds under brute force.
 *
 * `concealFailureReason`: when true, every failure (unknown id, wrong code,
 * expired, attempts exhausted) is reported as one identical error. Required
 * wherever the flow must not reveal whether an account exists (password
 * reset), because the reason would differ between a real request and a decoy.
 * The real reason is still recorded in the audit log.
 *
 * `userId`: when given, the code must have been requested by that user. A
 * request belonging to anyone else is treated as unknown, without spending
 * one of its attempts, so one signed-in user cannot use up or redeem another
 * user's code.
 */
export async function verifyOtp(params: {
  verificationId: string;
  code: string;
  purpose: VerificationPurpose;
  context: RequestContext;
  concealFailureReason?: boolean;
  userId?: string;
}): Promise<VerificationTokenIssued & { channel: VerificationChannel; destination: string }> {
  const outcome = await sequelize.transaction(async (transaction): Promise<VerifyOutcome> => {
    const request = await VerificationRequest.scope('withSecrets').findByPk(params.verificationId, {
      lock: transaction.LOCK.UPDATE,
      transaction,
    });

    const invalid = AppError.badRequest('The verification code is invalid', ErrorCode.OTP_INVALID);
    const belongsToCaller = params.userId === undefined || request?.userId === params.userId;
    if (!request || request.purpose !== params.purpose || !belongsToCaller) {
      return { ok: false, error: invalid, request: null };
    }

    const now = new Date();
    if (request.invalidatedAt || request.consumedAt || request.verifiedAt || request.otpExpiresAt <= now) {
      return {
        ok: false,
        request,
        error: AppError.badRequest('This code has expired. Please request a new one', ErrorCode.OTP_EXPIRED),
      };
    }
    if (request.attempts >= request.maxAttempts) {
      return {
        ok: false,
        request,
        error: AppError.tooManyRequests(
          'Too many incorrect attempts. Please request a new code',
          ErrorCode.OTP_ATTEMPTS_EXCEEDED,
        ),
      };
    }

    request.attempts += 1;

    if (!safeEqualHex(otpDigest(request.id, params.code), request.otpHash)) {
      await request.save({ transaction });
      const remaining = request.maxAttempts - request.attempts;
      return {
        ok: false,
        request,
        error: AppError.badRequest('The verification code is invalid', ErrorCode.OTP_INVALID, [
          { message: 'Incorrect code', remainingAttempts: remaining },
        ]),
      };
    }

    const token = generateOpaqueToken();
    const tokenExpiresAt = new Date(now.getTime() + env.VERIFICATION_TOKEN_TTL_SECONDS * SECOND);
    request.verifiedAt = now;
    request.tokenHash = sha256Hex(token);
    request.tokenExpiresAt = tokenExpiresAt;
    await request.save({ transaction });

    await recordAudit(
      {
        actor: request.userId ? { type: 'user', id: request.userId } : { type: 'anonymous' },
        action: AuditAction.OTP_VERIFIED,
        entityType: 'verification_request',
        entityId: request.id,
        subjectUserId: request.userId,
        metadata: { purpose: request.purpose, channel: request.channel },
        context: params.context,
      },
      transaction,
    );

    return { ok: true, request, issued: { verificationToken: token, expiresAt: tokenExpiresAt } };
  });

  if (!outcome.ok) {
    await recordAuditIndependently({
      actor: outcome.request?.userId ? { type: 'user', id: outcome.request.userId } : { type: 'anonymous' },
      action: AuditAction.OTP_VERIFY_FAILED,
      entityType: 'verification_request',
      entityId: outcome.request?.id ?? null,
      subjectUserId: outcome.request?.userId ?? null,
      severity: 'warning',
      outcome: 'failure',
      metadata: { purpose: params.purpose, reason: outcome.error.code },
      context: params.context,
    });
    if (params.concealFailureReason) {
      throw AppError.badRequest('The code is invalid or has expired', ErrorCode.OTP_INVALID);
    }
    throw outcome.error;
  }

  return { ...outcome.issued, channel: outcome.request.channel, destination: outcome.request.destination };
}

/**
 * Spend a verification token inside the caller's transaction. The row is
 * locked, so a token can be consumed exactly once even under concurrency.
 * The token must match purpose, channel and — critically — the exact
 * destination being registered/reset.
 */
export async function consumeVerificationToken(
  params: {
    token: string;
    purpose: VerificationPurpose;
    channel: VerificationChannel;
    destination?: string;
    invalidError: AppError;
  },
  transaction: Transaction,
): Promise<VerificationRequest> {
  const request = await VerificationRequest.findOne({
    where: { tokenHash: sha256Hex(params.token) },
    lock: transaction.LOCK.UPDATE,
    transaction,
  });

  const now = new Date();
  const valid =
    request !== null &&
    request.purpose === params.purpose &&
    request.channel === params.channel &&
    (params.destination === undefined || request.destination === params.destination) &&
    request.verifiedAt !== null &&
    request.consumedAt === null &&
    request.invalidatedAt === null &&
    request.tokenExpiresAt !== null &&
    request.tokenExpiresAt > now;

  if (!valid || !request) throw params.invalidError;

  request.consumedAt = now;
  await request.save({ transaction });
  return request;
}
