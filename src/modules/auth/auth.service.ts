import { randomUUID } from 'node:crypto';
import { Sequelize, type Transaction } from 'sequelize';
import { env } from '../../config/env.js';
import { sequelize } from '../../db/sequelize.js';
import { AppError } from '../../common/errors/AppError.js';
import { ErrorCode } from '../../common/errors/errorCodes.js';
import type { RequestContext } from '../../common/http/requestContext.js';
import {
  burnPasswordVerification,
  hashPassword,
  passwordNeedsRehash,
  verifyPassword,
} from '../../common/utils/password.js';
import { User } from '../../models/index.js';
import type { ClientType } from '../../models/enums.js';
import { recordAudit, recordAuditIndependently } from '../audit/audit.service.js';
import { AuditAction } from '../audit/auditActions.js';
import { getPendingPolicies } from '../policies/policy.service.js';
import { serializeUser } from '../users/user.serializer.js';
import { consumeVerificationToken, issueOtp, verifyOtp } from '../verification/verification.service.js';
import { passwordAvoidsIdentity } from './auth.schemas.js';
import {
  createSession,
  findSessionByRefreshToken,
  revokeAllUserSessions,
  revokeSession,
  rotateRefreshToken,
  type IssuedTokens,
} from './session.service.js';

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

function usernameTakenWhere(username: string) {
  return Sequelize.where(Sequelize.fn('LOWER', Sequelize.col('username')), username.toLowerCase());
}

export async function isUsernameAvailable(username: string, transaction?: Transaction): Promise<boolean> {
  const count = await User.count({ where: usernameTakenWhere(username), transaction });
  return count === 0;
}

async function assertEmailFree(email: string, transaction?: Transaction): Promise<void> {
  if ((await User.count({ where: { email }, transaction })) > 0) {
    throw AppError.conflict('This email is already registered', ErrorCode.EMAIL_ALREADY_REGISTERED, [
      { path: 'email', message: 'This email is already registered' },
    ]);
  }
}

async function assertPhoneFree(phone: string, transaction?: Transaction): Promise<void> {
  if ((await User.count({ where: { phone }, transaction })) > 0) {
    throw AppError.conflict('This phone number is already registered', ErrorCode.PHONE_ALREADY_REGISTERED, [
      { path: 'phone', message: 'This phone number is already registered' },
    ]);
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export async function sendRegistrationEmailOtp(email: string, context: RequestContext) {
  await assertEmailFree(email);
  return issueOtp({ purpose: 'registration', channel: 'email', destination: email, context });
}

export async function sendRegistrationPhoneOtp(phone: string, context: RequestContext) {
  await assertPhoneFree(phone);
  return issueOtp({ purpose: 'registration', channel: 'sms', destination: phone, context });
}

export async function verifyRegistrationOtp(verificationId: string, otp: string, context: RequestContext) {
  const result = await verifyOtp({ verificationId, code: otp, purpose: 'registration', context });
  return {
    verificationToken: result.verificationToken,
    expiresAt: result.expiresAt,
    channel: result.channel,
  };
}

export interface RegisterInput {
  fullName: string;
  username: string;
  email: string;
  phone: string;
  password: string;
  emailVerificationToken: string;
  phoneVerificationToken: string;
}

/**
 * Create the account. Both verification tokens are consumed in the same
 * transaction as the insert, and each must have been issued for exactly the
 * email / phone submitted. The unique indexes are the final guard against
 * concurrent registrations.
 */
export async function registerUser(input: RegisterInput, context: RequestContext) {
  const passwordHash = await hashPassword(input.password);

  const user = await sequelize.transaction(async (transaction) => {
    const emailVerification = await consumeVerificationToken(
      {
        token: input.emailVerificationToken,
        purpose: 'registration',
        channel: 'email',
        destination: input.email,
        invalidError: AppError.unprocessable(
          'Email verification is missing or has expired. Please verify your email again',
          ErrorCode.EMAIL_NOT_VERIFIED,
          [{ path: 'emailVerificationToken', message: 'Email is not verified' }],
        ),
      },
      transaction,
    );
    const phoneVerification = await consumeVerificationToken(
      {
        token: input.phoneVerificationToken,
        purpose: 'registration',
        channel: 'sms',
        destination: input.phone,
        invalidError: AppError.unprocessable(
          'Phone verification is missing or has expired. Please verify your phone number again',
          ErrorCode.PHONE_NOT_VERIFIED,
          [{ path: 'phoneVerificationToken', message: 'Phone number is not verified' }],
        ),
      },
      transaction,
    );

    await assertEmailFree(input.email, transaction);
    await assertPhoneFree(input.phone, transaction);
    if (!(await isUsernameAvailable(input.username, transaction))) {
      throw AppError.conflict('This username is already taken', ErrorCode.USERNAME_TAKEN, [
        { path: 'username', message: 'This username is already taken' },
      ]);
    }

    const created = await User.create(
      {
        fullName: input.fullName,
        username: input.username,
        email: input.email,
        phone: input.phone,
        passwordHash,
        emailVerifiedAt: emailVerification.verifiedAt ?? new Date(),
        phoneVerifiedAt: phoneVerification.verifiedAt ?? new Date(),
      },
      { transaction },
    );

    await recordAudit(
      {
        actor: { type: 'user', id: created.id },
        action: AuditAction.USER_REGISTERED,
        entityType: 'user',
        entityId: created.id,
        subjectUserId: created.id,
        after: {
          fullName: created.fullName,
          username: created.username,
          email: created.email,
          phone: created.phone,
        },
        context,
      },
      transaction,
    );

    return created;
  });

  return serializeUser(user);
}

// ---------------------------------------------------------------------------
// Login / refresh / logout
// ---------------------------------------------------------------------------

export type NextAction = 'onboarding' | 'policy_acceptance' | null;

/** Where the client should send the user after authenticating. */
export async function resolveNextAction(user: User): Promise<NextAction> {
  if (user.onboardingStatus !== 'completed') return 'onboarding';
  const pending = await getPendingPolicies(user.id);
  return pending.length > 0 ? 'policy_acceptance' : null;
}

export interface LoginInput {
  identifier: { kind: 'email' | 'phone'; value: string };
  password: string;
  deviceName?: string | undefined;
}

export interface LoginResult {
  tokens: IssuedTokens;
  user: ReturnType<typeof serializeUser>;
  nextAction: NextAction;
}

const invalidCredentials = (): AppError =>
  AppError.unauthorized('Invalid email/phone or password', ErrorCode.INVALID_CREDENTIALS);

/**
 * Authenticate with email-or-phone + password and open a session.
 *
 * - Unknown identifiers still run a full Argon2 verification so response time
 *   does not reveal which accounts exist.
 * - After LOGIN_MAX_FAILED_ATTEMPTS consecutive failures the account is
 *   locked for LOGIN_LOCKOUT_MINUTES.
 * - A blocked account is only reported after a correct password, so the
 *   "disabled" status is not disclosed to someone guessing.
 */
export async function loginUser(input: LoginInput, clientType: ClientType, context: RequestContext): Promise<LoginResult> {
  const where = input.identifier.kind === 'email' ? { email: input.identifier.value } : { phone: input.identifier.value };
  const user = await User.scope('withSecrets').findOne({ where });

  if (!user) {
    await burnPasswordVerification(input.password);
    await recordAuditIndependently({
      actor: { type: 'anonymous' },
      action: AuditAction.USER_LOGIN_FAILED,
      severity: 'warning',
      outcome: 'failure',
      metadata: { reason: 'unknown_identifier', identifierKind: input.identifier.kind, clientType },
      context,
    });
    throw invalidCredentials();
  }

  const now = new Date();
  if (user.lockedUntil && user.lockedUntil > now) {
    await recordAuditIndependently({
      actor: { type: 'user', id: user.id },
      action: AuditAction.USER_LOGIN_FAILED,
      subjectUserId: user.id,
      severity: 'warning',
      outcome: 'failure',
      metadata: { reason: 'account_locked', clientType },
      context,
    });
    throw new AppError(423, ErrorCode.ACCOUNT_LOCKED, 'Too many failed attempts. Please try again later', [
      { message: 'Account temporarily locked', retryAfterSeconds: Math.ceil((user.lockedUntil.getTime() - now.getTime()) / 1000) },
    ]);
  }

  const passwordOk = await verifyPassword(user.passwordHash, input.password);

  if (!passwordOk) {
    await registerFailedLogin(user.id, context, clientType);
    throw invalidCredentials();
  }

  if (user.status !== 'active') {
    await recordAuditIndependently({
      actor: { type: 'user', id: user.id },
      action: AuditAction.USER_LOGIN_FAILED,
      subjectUserId: user.id,
      severity: 'warning',
      outcome: 'failure',
      metadata: { reason: 'account_blocked', clientType },
      context,
    });
    throw AppError.forbidden('Your account has been disabled. Please contact support', ErrorCode.ACCOUNT_DISABLED);
  }

  const rehash = passwordNeedsRehash(user.passwordHash) ? await hashPassword(input.password) : null;

  const tokens = await sequelize.transaction(async (transaction) => {
    await User.update(
      {
        failedLoginAttempts: 0,
        lockedUntil: null,
        lastLoginAt: now,
        ...(rehash ? { passwordHash: rehash } : {}),
      },
      { where: { id: user.id }, transaction },
    );

    const issued = await createSession(
      { subject: { type: 'user', id: user.id }, clientType, deviceName: input.deviceName ?? null, context },
      transaction,
    );

    await recordAudit(
      {
        actor: { type: 'user', id: user.id },
        action: AuditAction.USER_LOGIN_SUCCEEDED,
        entityType: 'auth_session',
        entityId: issued.sessionId,
        subjectUserId: user.id,
        metadata: { clientType, identifierKind: input.identifier.kind, deviceName: input.deviceName ?? null },
        context,
      },
      transaction,
    );

    return issued;
  });

  user.lastLoginAt = now;
  return { tokens, user: serializeUser(user), nextAction: await resolveNextAction(user) };
}

/**
 * Atomically increment the failure counter and lock the account when the
 * threshold is reached. Done with a row lock so concurrent bad attempts are
 * all counted.
 */
async function registerFailedLogin(userId: string, context: RequestContext, clientType: ClientType): Promise<void> {
  const locked = await sequelize.transaction(async (transaction) => {
    const row = await User.findByPk(userId, {
      attributes: ['id', 'failedLoginAttempts', 'lockedUntil'],
      lock: transaction.LOCK.UPDATE,
      transaction,
    });
    if (!row) return false;

    const attempts = row.failedLoginAttempts + 1;
    const shouldLock = attempts >= env.LOGIN_MAX_FAILED_ATTEMPTS;
    await User.update(
      shouldLock
        ? { failedLoginAttempts: 0, lockedUntil: new Date(Date.now() + env.LOGIN_LOCKOUT_MINUTES * 60_000) }
        : { failedLoginAttempts: attempts },
      { where: { id: userId }, transaction },
    );
    return shouldLock;
  });

  await recordAuditIndependently({
    actor: { type: 'user', id: userId },
    action: locked ? AuditAction.USER_ACCOUNT_LOCKED : AuditAction.USER_LOGIN_FAILED,
    subjectUserId: userId,
    severity: locked ? 'critical' : 'warning',
    outcome: 'failure',
    metadata: { reason: 'invalid_password', clientType },
    context,
  });
}

/** Rotate a user refresh token; rejects if the account is no longer active. */
export async function refreshUserSession(refreshToken: string, clientType: ClientType, context: RequestContext) {
  return rotateRefreshToken({
    refreshToken,
    subjectType: 'user',
    clientType,
    context,
    assertSubjectAllowed: async (userId, transaction) => {
      const user = await User.findByPk(userId, { attributes: ['id', 'status'], transaction });
      if (!user || user.status !== 'active') {
        throw AppError.forbidden('Your account has been disabled. Please contact support', ErrorCode.ACCOUNT_DISABLED);
      }
    },
  });
}

/** Revoke the session behind a refresh token. Idempotent for unknown tokens. */
export async function logoutUser(refreshToken: string | null, clientType: ClientType, context: RequestContext): Promise<void> {
  if (!refreshToken) return;
  const session = await findSessionByRefreshToken(refreshToken, 'user', clientType);
  if (!session?.userId || session.revokedAt) return;
  const userId = session.userId;

  await sequelize.transaction(async (transaction) => {
    const revoked = await revokeSession(session.id, 'logout', transaction);
    if (!revoked) return;
    await recordAudit(
      {
        actor: { type: 'user', id: userId },
        action: AuditAction.USER_LOGGED_OUT,
        entityType: 'auth_session',
        entityId: session.id,
        subjectUserId: userId,
        metadata: { clientType },
        context,
      },
      transaction,
    );
  });
}

// ---------------------------------------------------------------------------
// Forgot / reset password (OTP to email)
// ---------------------------------------------------------------------------

/** The response a caller sees whenever no code is actually sent. */
function passwordResetDecoy() {
  const now = Date.now();
  return {
    verificationId: randomUUID(),
    channel: 'email' as const,
    expiresAt: new Date(now + env.OTP_TTL_SECONDS * 1000),
    resendAvailableAt: new Date(now + env.OTP_RESEND_COOLDOWN_SECONDS * 1000),
  };
}

/**
 * Errors that only a REAL account can trigger. Surfacing them would let anyone
 * probe which emails are registered, so the reset flow masks them as a decoy.
 */
const MASKED_RESET_ERRORS = new Set<string>([
  ErrorCode.OTP_RESEND_TOO_SOON,
  ErrorCode.OTP_SEND_LIMIT_REACHED,
  ErrorCode.OTP_DELIVERY_FAILED,
]);

/**
 * Start a password reset. The response is identical — same status, same
 * shape — for unknown emails, blocked accounts, throttled requests and real
 * sends, so the endpoint cannot be used to discover accounts. The real outcome
 * is recorded in the audit log.
 */
export async function requestPasswordReset(email: string, context: RequestContext) {
  const user = await User.findOne({ where: { email }, attributes: ['id', 'status'] });

  if (!user || user.status !== 'active') {
    await recordAuditIndependently({
      actor: user ? { type: 'user', id: user.id } : { type: 'anonymous' },
      action: AuditAction.PASSWORD_RESET_REQUESTED,
      subjectUserId: user?.id ?? null,
      outcome: 'failure',
      severity: 'warning',
      metadata: { reason: user ? 'account_blocked' : 'unknown_email' },
      context,
    });
    return passwordResetDecoy();
  }

  try {
    return await issueOtp({ purpose: 'password_reset', channel: 'email', destination: email, userId: user.id, context });
  } catch (error) {
    if (!(error instanceof AppError) || !MASKED_RESET_ERRORS.has(error.code)) throw error;
    await recordAuditIndependently({
      actor: { type: 'user', id: user.id },
      action: AuditAction.PASSWORD_RESET_REQUESTED,
      subjectUserId: user.id,
      outcome: 'failure',
      severity: 'warning',
      metadata: { reason: error.code },
      context,
    });
    return passwordResetDecoy();
  }
}

export async function verifyPasswordResetOtp(verificationId: string, otp: string, context: RequestContext) {
  const result = await verifyOtp({
    verificationId,
    code: otp,
    purpose: 'password_reset',
    context,
    concealFailureReason: true,
  });
  return { resetToken: result.verificationToken, expiresAt: result.expiresAt };
}

/**
 * Complete a password reset: consume the reset token, set the new password,
 * clear any lockout and sign the user out everywhere.
 */
export async function resetPassword(resetToken: string, newPassword: string, context: RequestContext): Promise<void> {
  const newHash = await hashPassword(newPassword);

  await sequelize.transaction(async (transaction) => {
    const verification = await consumeVerificationToken(
      {
        token: resetToken,
        purpose: 'password_reset',
        channel: 'email',
        invalidError: AppError.badRequest(
          'This reset link has expired. Please start again',
          ErrorCode.RESET_TOKEN_INVALID,
        ),
      },
      transaction,
    );

    const user = await User.scope('withSecrets').findByPk(verification.userId ?? '', {
      lock: transaction.LOCK.UPDATE,
      transaction,
    });
    if (!user || user.status !== 'active' || user.email !== verification.destination) {
      throw AppError.badRequest('This reset link has expired. Please start again', ErrorCode.RESET_TOKEN_INVALID);
    }

    if (await verifyPassword(user.passwordHash, newPassword)) {
      throw AppError.unprocessable('New password must differ from your current password', ErrorCode.PASSWORD_REUSE, [
        { path: 'newPassword', message: 'New password must differ from your current password' },
      ]);
    }
    // Same identity rule as registration and change-password. Throwing here
    // rolls back the transaction, so the reset token stays usable for a retry.
    if (!passwordAvoidsIdentity(newPassword, { username: user.username, email: user.email })) {
      throw AppError.unprocessable('Password must not contain your username or email', ErrorCode.VALIDATION_ERROR, [
        { path: 'newPassword', message: 'Password must not contain your username or email' },
      ]);
    }

    const now = new Date();
    await User.update(
      { passwordHash: newHash, passwordChangedAt: now, failedLoginAttempts: 0, lockedUntil: null },
      { where: { id: user.id }, transaction },
    );
    const revokedSessions = await revokeAllUserSessions(user.id, 'password_reset', transaction);

    await recordAudit(
      {
        actor: { type: 'user', id: user.id },
        action: AuditAction.PASSWORD_RESET_COMPLETED,
        entityType: 'user',
        entityId: user.id,
        subjectUserId: user.id,
        severity: 'warning',
        metadata: { revokedSessions },
        context,
      },
      transaction,
    );
  });
}
