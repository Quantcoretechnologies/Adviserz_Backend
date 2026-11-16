import { Op, type Transaction } from 'sequelize';
import { env } from '../../config/env.js';
import { sequelize } from '../../db/sequelize.js';
import { AppError } from '../../common/errors/AppError.js';
import { ErrorCode } from '../../common/errors/errorCodes.js';
import type { RequestContext } from '../../common/http/requestContext.js';
import { generateOpaqueToken, sha256Hex } from '../../common/utils/crypto.js';
import { AuthSession, RefreshToken } from '../../models/index.js';
import type { ClientType, SessionRevokeReason } from '../../models/enums.js';
import { recordAuditIndependently } from '../audit/audit.service.js';
import { AuditAction } from '../audit/auditActions.js';
import { signAccessToken, type SubjectType } from './token.service.js';

export interface SessionSubject {
  type: SubjectType;
  id: string;
}

export interface IssuedTokens {
  sessionId: string;
  accessToken: string;
  accessTokenExpiresAt: Date;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/**
 * Users get a sliding refresh window capped by an absolute session lifetime.
 * Admin sessions are short and non-sliding: re-login every N hours.
 */
function sessionLifetime(subjectType: SubjectType, now: Date): { sessionExpiresAt: Date; refreshTtlMs: number } {
  if (subjectType === 'admin') {
    const ttl = env.ADMIN_REFRESH_TOKEN_TTL_HOURS * HOUR_MS;
    return { sessionExpiresAt: new Date(now.getTime() + ttl), refreshTtlMs: ttl };
  }
  return {
    sessionExpiresAt: new Date(now.getTime() + env.SESSION_MAX_AGE_DAYS * DAY_MS),
    refreshTtlMs: env.REFRESH_TOKEN_TTL_DAYS * DAY_MS,
  };
}

function refreshExpiry(now: Date, refreshTtlMs: number, sessionExpiresAt: Date): Date {
  return new Date(Math.min(now.getTime() + refreshTtlMs, sessionExpiresAt.getTime()));
}

/**
 * Open a new session for a subject and issue its first token pair.
 * Must be called inside the caller's transaction (e.g. login).
 */
export async function createSession(
  params: {
    subject: SessionSubject;
    clientType: ClientType;
    deviceName?: string | null;
    context: RequestContext;
  },
  transaction: Transaction,
): Promise<IssuedTokens> {
  const now = new Date();
  const { sessionExpiresAt, refreshTtlMs } = sessionLifetime(params.subject.type, now);

  const session = await AuthSession.create(
    {
      userId: params.subject.type === 'user' ? params.subject.id : null,
      adminId: params.subject.type === 'admin' ? params.subject.id : null,
      clientType: params.clientType,
      deviceName: params.deviceName ?? null,
      userAgent: params.context.userAgent,
      ipAddress: params.context.ipAddress,
      lastUsedAt: now,
      expiresAt: sessionExpiresAt,
    },
    { transaction },
  );

  const refreshToken = generateOpaqueToken();
  const refreshTokenExpiresAt = refreshExpiry(now, refreshTtlMs, sessionExpiresAt);
  await RefreshToken.create(
    { sessionId: session.id, tokenHash: sha256Hex(refreshToken), expiresAt: refreshTokenExpiresAt },
    { transaction },
  );

  const access = signAccessToken(params.subject.type, { sub: params.subject.id, sid: session.id });
  return { sessionId: session.id, ...access, refreshToken, refreshTokenExpiresAt };
}

type RotationOutcome =
  | { kind: 'rotated'; tokens: IssuedTokens; subjectId: string }
  | { kind: 'reuse'; sessionId: string; subjectId: string }
  | { kind: 'error'; error: AppError };

const invalidRefresh = (): AppError =>
  AppError.unauthorized('Refresh token is invalid', ErrorCode.REFRESH_TOKEN_INVALID);

/**
 * Exchange a refresh token for a new token pair (rotation).
 *
 * The token row is locked FOR UPDATE, so two concurrent refreshes with the
 * same token serialise: the first rotates, the second sees a rotated token and
 * is treated as reuse. Reuse revokes the whole session (token family) — the
 * revocation is committed even though the request fails.
 */
export async function rotateRefreshToken(params: {
  refreshToken: string;
  subjectType: SubjectType;
  clientType: ClientType;
  context: RequestContext;
  /** Extra subject check (e.g. user still active); throw AppError to reject. */
  assertSubjectAllowed: (subjectId: string, transaction: Transaction) => Promise<void>;
}): Promise<IssuedTokens> {
  const tokenHash = sha256Hex(params.refreshToken);

  const outcome = await sequelize.transaction(async (transaction): Promise<RotationOutcome> => {
    const token = await RefreshToken.findOne({
      where: { tokenHash },
      lock: transaction.LOCK.UPDATE,
      transaction,
    });
    if (!token) return { kind: 'error', error: invalidRefresh() };

    const session = await AuthSession.findByPk(token.sessionId, { lock: transaction.LOCK.UPDATE, transaction });
    if (!session) return { kind: 'error', error: invalidRefresh() };

    const subjectId = params.subjectType === 'admin' ? session.adminId : session.userId;
    // A token presented on the wrong surface (admin vs user, web vs mobile) is
    // simply invalid there — never a hint that it exists elsewhere.
    if (!subjectId || session.clientType !== params.clientType) {
      return { kind: 'error', error: invalidRefresh() };
    }

    if (session.revokedAt) {
      return {
        kind: 'error',
        error: AppError.unauthorized('Session has been revoked', ErrorCode.SESSION_REVOKED),
      };
    }

    const now = new Date();

    if (token.rotatedAt) {
      // Within the grace window this is almost certainly two requests from the
      // same client racing (e.g. two browser tabs). Reject it, but keep the
      // session: the winner already holds the new token. 409 (not 401) so web
      // clients do not clear the cookie the winning request just set.
      const sinceRotationMs = now.getTime() - token.rotatedAt.getTime();
      if (sinceRotationMs <= env.REFRESH_TOKEN_REUSE_GRACE_SECONDS * 1000) {
        return {
          kind: 'error',
          error: AppError.conflict(
            'This session was just refreshed by another request. Retry with the latest token',
            ErrorCode.REFRESH_TOKEN_ALREADY_ROTATED,
          ),
        };
      }
      await revokeSessionRecord(session, 'token_reuse_detected', transaction);
      return { kind: 'reuse', sessionId: session.id, subjectId };
    }

    if (session.expiresAt <= now || token.expiresAt <= now) {
      await revokeSessionRecord(session, 'expired', transaction);
      return {
        kind: 'error',
        error: AppError.unauthorized('Session has expired, please sign in again', ErrorCode.SESSION_EXPIRED),
      };
    }

    try {
      await params.assertSubjectAllowed(subjectId, transaction);
    } catch (error) {
      if (error instanceof AppError) return { kind: 'error', error };
      throw error;
    }

    const { refreshTtlMs } = sessionLifetime(params.subjectType, now);
    const nextPlain = generateOpaqueToken();
    const nextExpiresAt = refreshExpiry(now, refreshTtlMs, session.expiresAt);

    // Mark the old token rotated BEFORE inserting its successor: the partial
    // unique index allows only one live token per session.
    token.rotatedAt = now;
    await token.save({ transaction });
    const next = await RefreshToken.create(
      { sessionId: session.id, tokenHash: sha256Hex(nextPlain), expiresAt: nextExpiresAt },
      { transaction },
    );
    token.replacedById = next.id;
    await token.save({ transaction });

    session.lastUsedAt = now;
    session.ipAddress = params.context.ipAddress;
    session.userAgent = params.context.userAgent;
    await session.save({ transaction });

    const access = signAccessToken(params.subjectType, { sub: subjectId, sid: session.id });
    return {
      kind: 'rotated',
      subjectId,
      tokens: { sessionId: session.id, ...access, refreshToken: nextPlain, refreshTokenExpiresAt: nextExpiresAt },
    };
  });

  if (outcome.kind === 'error') throw outcome.error;

  if (outcome.kind === 'reuse') {
    await recordAuditIndependently({
      actor: { type: params.subjectType, id: outcome.subjectId },
      action: AuditAction.REFRESH_TOKEN_REUSE_DETECTED,
      entityType: 'auth_session',
      entityId: outcome.sessionId,
      subjectUserId: params.subjectType === 'user' ? outcome.subjectId : null,
      severity: 'critical',
      outcome: 'failure',
      metadata: { clientType: params.clientType },
      context: params.context,
    });
    throw AppError.unauthorized(
      'Refresh token reuse detected; this session has been signed out',
      ErrorCode.TOKEN_REUSE_DETECTED,
    );
  }

  return outcome.tokens;
}

async function revokeSessionRecord(
  session: AuthSession,
  reason: SessionRevokeReason,
  transaction: Transaction,
): Promise<void> {
  if (session.revokedAt) return;
  session.revokedAt = new Date();
  session.revokedReason = reason;
  await session.save({ transaction });
}

/**
 * Resolve the session a refresh token belongs to, for logout. Returns null
 * for unknown tokens (logout stays idempotent).
 */
export async function findSessionByRefreshToken(
  refreshToken: string,
  subjectType: SubjectType,
  clientType: ClientType,
): Promise<AuthSession | null> {
  const token = await RefreshToken.findOne({ where: { tokenHash: sha256Hex(refreshToken) } });
  if (!token) return null;
  const session = await AuthSession.findByPk(token.sessionId);
  if (!session || session.clientType !== clientType) return null;
  const subjectId = subjectType === 'admin' ? session.adminId : session.userId;
  return subjectId ? session : null;
}

export async function revokeSession(
  sessionId: string,
  reason: SessionRevokeReason,
  transaction: Transaction,
): Promise<boolean> {
  const [count] = await AuthSession.update(
    { revokedAt: new Date(), revokedReason: reason },
    { where: { id: sessionId, revokedAt: null }, transaction },
  );
  return count > 0;
}

/** Revoke every live session of a user, optionally keeping one. Returns the count. */
export async function revokeAllUserSessions(
  userId: string,
  reason: SessionRevokeReason,
  transaction: Transaction,
  exceptSessionId?: string,
): Promise<number> {
  const [count] = await AuthSession.update(
    { revokedAt: new Date(), revokedReason: reason },
    {
      where: {
        userId,
        revokedAt: null,
        ...(exceptSessionId ? { id: { [Op.ne]: exceptSessionId } } : {}),
      },
      transaction,
    },
  );
  return count;
}

/**
 * Load a session for access-token authentication and confirm it is live.
 */
export async function assertSessionActive(
  sessionId: string,
  subjectType: SubjectType,
  subjectId: string,
): Promise<AuthSession> {
  const session = await AuthSession.findByPk(sessionId);
  const owner = subjectType === 'admin' ? session?.adminId : session?.userId;
  if (!session || owner !== subjectId) {
    throw AppError.unauthorized('Access token is invalid', ErrorCode.ACCESS_TOKEN_INVALID);
  }
  if (session.revokedAt) {
    throw AppError.unauthorized('Session has been revoked', ErrorCode.SESSION_REVOKED);
  }
  if (session.expiresAt <= new Date()) {
    throw AppError.unauthorized('Session has expired, please sign in again', ErrorCode.SESSION_EXPIRED);
  }
  return session;
}
