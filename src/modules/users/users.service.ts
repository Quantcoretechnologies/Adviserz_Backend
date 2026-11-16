import { Op } from 'sequelize';
import { sequelize } from '../../db/sequelize.js';
import { AppError } from '../../common/errors/AppError.js';
import { ErrorCode } from '../../common/errors/errorCodes.js';
import type { RequestContext } from '../../common/http/requestContext.js';
import { hashPassword, verifyPassword } from '../../common/utils/password.js';
import { passwordAvoidsIdentity } from '../auth/auth.schemas.js';
import { AuthSession, User } from '../../models/index.js';
import { recordAudit } from '../audit/audit.service.js';
import { AuditAction } from '../audit/auditActions.js';
import { isUsernameAvailable } from '../auth/auth.service.js';
import { revokeAllUserSessions, revokeSession } from '../auth/session.service.js';
import { acceptPolicies, getPendingPolicies, serializePolicy } from '../policies/policy.service.js';
import { serializeUser } from './user.serializer.js';

async function loadUser(userId: string): Promise<User> {
  const user = await User.findByPk(userId);
  if (!user) throw AppError.unauthorized();
  return user;
}

/**
 * The signed-in user plus what they still owe, so both clients can route
 * consistently (onboarding first, then any updated policies).
 */
export async function getMe(userId: string) {
  const user = await loadUser(userId);
  const pendingPolicies = user.onboardingStatus === 'completed' ? await getPendingPolicies(userId) : [];
  return {
    user: serializeUser(user),
    requirements: {
      onboardingRequired: user.onboardingStatus !== 'completed',
      policyAcceptanceRequired: pendingPolicies.length > 0,
      pendingPolicies: pendingPolicies.map((doc) => serializePolicy(doc, { includeContent: false })),
    },
  };
}

export async function updateProfile(
  userId: string,
  changes: { fullName?: string | undefined; username?: string | undefined },
  context: RequestContext,
) {
  const user = await sequelize.transaction(async (transaction) => {
    const current = await User.findByPk(userId, { lock: transaction.LOCK.UPDATE, transaction });
    if (!current) throw AppError.unauthorized();

    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};

    if (changes.fullName !== undefined && changes.fullName !== current.fullName) {
      before['fullName'] = current.fullName;
      after['fullName'] = changes.fullName;
      current.fullName = changes.fullName;
    }

    if (changes.username !== undefined && changes.username !== current.username) {
      const caseOnlyChange = changes.username.toLowerCase() === current.username.toLowerCase();
      if (!caseOnlyChange && !(await isUsernameAvailable(changes.username, transaction))) {
        throw AppError.conflict('This username is already taken', ErrorCode.USERNAME_TAKEN, [
          { path: 'username', message: 'This username is already taken' },
        ]);
      }
      before['username'] = current.username;
      after['username'] = changes.username;
      current.username = changes.username;
    }

    if (Object.keys(after).length === 0) return current;

    await current.save({ transaction });
    await recordAudit(
      {
        actor: { type: 'user', id: userId },
        action: AuditAction.PROFILE_UPDATED,
        entityType: 'user',
        entityId: userId,
        subjectUserId: userId,
        before,
        after,
        context,
      },
      transaction,
    );
    return current;
  });

  return serializeUser(user);
}

/**
 * Change password while signed in. Every OTHER session is revoked; the
 * current device stays signed in because the user just proved the current
 * password.
 */
export async function changePassword(
  userId: string,
  currentSessionId: string,
  input: { currentPassword: string; newPassword: string },
  context: RequestContext,
): Promise<{ revokedSessions: number }> {
  const user = await User.scope('withSecrets').findByPk(userId);
  if (!user) throw AppError.unauthorized();

  if (!(await verifyPassword(user.passwordHash, input.currentPassword))) {
    throw AppError.badRequest('Current password is incorrect', ErrorCode.CURRENT_PASSWORD_INCORRECT, [
      { path: 'currentPassword', message: 'Current password is incorrect' },
    ]);
  }
  if (input.newPassword === input.currentPassword) {
    throw AppError.unprocessable('New password must differ from your current password', ErrorCode.PASSWORD_REUSE, [
      { path: 'newPassword', message: 'New password must differ from your current password' },
    ]);
  }
  if (!passwordAvoidsIdentity(input.newPassword, { username: user.username, email: user.email })) {
    throw AppError.unprocessable('Password must not contain your username or email', ErrorCode.VALIDATION_ERROR, [
      { path: 'newPassword', message: 'Password must not contain your username or email' },
    ]);
  }

  const newHash = await hashPassword(input.newPassword);

  return sequelize.transaction(async (transaction) => {
    await User.update(
      { passwordHash: newHash, passwordChangedAt: new Date() },
      { where: { id: userId }, transaction },
    );
    const revokedSessions = await revokeAllUserSessions(userId, 'password_changed', transaction, currentSessionId);

    await recordAudit(
      {
        actor: { type: 'user', id: userId },
        action: AuditAction.PASSWORD_CHANGED,
        entityType: 'user',
        entityId: userId,
        subjectUserId: userId,
        severity: 'warning',
        metadata: { revokedSessions },
        context,
      },
      transaction,
    );
    return { revokedSessions };
  });
}

// ---------------------------------------------------------------------------
// Sessions (devices)
// ---------------------------------------------------------------------------

export async function listSessions(userId: string, currentSessionId: string) {
  const sessions = await AuthSession.findAll({
    where: { userId, revokedAt: null, expiresAt: { [Op.gt]: new Date() } },
    order: [['lastUsedAt', 'DESC']],
  });
  return sessions.map((session) => ({
    id: session.id,
    clientType: session.clientType,
    deviceName: session.deviceName,
    userAgent: session.userAgent,
    ipAddress: session.ipAddress,
    createdAt: session.createdAt,
    lastUsedAt: session.lastUsedAt,
    expiresAt: session.expiresAt,
    isCurrent: session.id === currentSessionId,
  }));
}

export async function revokeOwnSession(userId: string, sessionId: string, context: RequestContext): Promise<void> {
  const session = await AuthSession.findOne({ where: { id: sessionId, userId } });
  if (!session) throw AppError.notFound('Session not found');

  await sequelize.transaction(async (transaction) => {
    const revoked = await revokeSession(sessionId, 'revoked_by_user', transaction);
    if (!revoked) return;
    await recordAudit(
      {
        actor: { type: 'user', id: userId },
        action: AuditAction.SESSION_REVOKED,
        entityType: 'auth_session',
        entityId: sessionId,
        subjectUserId: userId,
        context,
      },
      transaction,
    );
  });
}

/** Sign out other devices (keepCurrent) or every device including this one. */
export async function revokeSessions(
  userId: string,
  currentSessionId: string,
  keepCurrent: boolean,
  context: RequestContext,
): Promise<{ revokedSessions: number }> {
  return sequelize.transaction(async (transaction) => {
    const revokedSessions = await revokeAllUserSessions(
      userId,
      'logout_all',
      transaction,
      keepCurrent ? currentSessionId : undefined,
    );
    await recordAudit(
      {
        actor: { type: 'user', id: userId },
        action: AuditAction.SESSIONS_REVOKED,
        entityType: 'auth_session',
        subjectUserId: userId,
        metadata: { revokedSessions, keepCurrent },
        context,
      },
      transaction,
    );
    return { revokedSessions };
  });
}

// ---------------------------------------------------------------------------
// Policies (re-acceptance after an admin publishes a new version)
// ---------------------------------------------------------------------------

export async function getPolicyStatus(userId: string) {
  const pending = await getPendingPolicies(userId);
  return {
    acceptanceRequired: pending.length > 0,
    pendingPolicies: pending.map((doc) => serializePolicy(doc, { includeContent: true })),
  };
}

export async function acceptCurrentPolicies(userId: string, policyDocumentIds: string[], context: RequestContext) {
  await sequelize.transaction(async (transaction) => {
    await acceptPolicies({ userId, policyDocumentIds, context }, transaction);
  });
  return getPolicyStatus(userId);
}
