import { env } from '../../config/env.js';
import { sequelize } from '../../db/sequelize.js';
import { AppError } from '../../common/errors/AppError.js';
import { ErrorCode } from '../../common/errors/errorCodes.js';
import type { RequestContext } from '../../common/http/requestContext.js';
import { burnPasswordVerification, hashPassword, verifyPassword } from '../../common/utils/password.js';
import { Admin } from '../../models/index.js';
import { recordAudit, recordAuditIndependently } from '../audit/audit.service.js';
import { AuditAction } from '../audit/auditActions.js';
import { getRolesHeldBy } from '../access/staffTree.service.js';
import { passwordAvoidsIdentity } from '../auth/auth.schemas.js';
import {
  createSession,
  findSessionByRefreshToken,
  revokeAllAdminSessions,
  revokeSession,
  rotateRefreshToken,
  type IssuedTokens,
} from '../auth/session.service.js';

export function serializeAdmin(admin: Admin) {
  return {
    id: admin.id,
    fullName: admin.fullName,
    email: admin.email,
    isSuperAdmin: admin.isSuperAdmin,
    mustChangePassword: admin.mustChangePassword,
    status: admin.status,
    lastLoginAt: admin.lastLoginAt,
  };
}

const invalidCredentials = (): AppError =>
  AppError.unauthorized('Invalid email or password', ErrorCode.INVALID_CREDENTIALS);

/** Admin sign-in (web only). Same lockout and timing protections as users. */
export async function loginAdmin(
  email: string,
  password: string,
  context: RequestContext,
): Promise<{ tokens: IssuedTokens; admin: ReturnType<typeof serializeAdmin> }> {
  // A deleted account cannot sign in and answers exactly like an unknown email.
  const admin = await Admin.scope('withSecrets').findOne({ where: { email, isDeleted: false } });

  if (!admin) {
    await burnPasswordVerification(password);
    await recordAuditIndependently({
      actor: { type: 'anonymous' },
      action: AuditAction.ADMIN_LOGIN_FAILED,
      severity: 'warning',
      outcome: 'failure',
      metadata: { reason: 'unknown_email' },
      context,
    });
    throw invalidCredentials();
  }

  const now = new Date();
  if (admin.lockedUntil && admin.lockedUntil > now) {
    await recordAuditIndependently({
      actor: { type: 'admin', id: admin.id },
      action: AuditAction.ADMIN_LOGIN_FAILED,
      severity: 'warning',
      outcome: 'failure',
      metadata: { reason: 'account_locked' },
      context,
    });
    throw new AppError(423, ErrorCode.ACCOUNT_LOCKED, 'Too many failed attempts. Please try again later', [
      { message: 'Account temporarily locked', retryAfterSeconds: Math.ceil((admin.lockedUntil.getTime() - now.getTime()) / 1000) },
    ]);
  }

  if (!(await verifyPassword(admin.passwordHash, password))) {
    const locked = await sequelize.transaction(async (transaction) => {
      const row = await Admin.findByPk(admin.id, { lock: transaction.LOCK.UPDATE, transaction });
      if (!row) return false;
      const attempts = row.failedLoginAttempts + 1;
      const shouldLock = attempts >= env.LOGIN_MAX_FAILED_ATTEMPTS;
      row.failedLoginAttempts = shouldLock ? 0 : attempts;
      row.lockedUntil = shouldLock ? new Date(Date.now() + env.LOGIN_LOCKOUT_MINUTES * 60_000) : row.lockedUntil;
      await row.save({ transaction });
      return shouldLock;
    });
    await recordAuditIndependently({
      actor: { type: 'admin', id: admin.id },
      action: AuditAction.ADMIN_LOGIN_FAILED,
      severity: locked ? 'critical' : 'warning',
      outcome: 'failure',
      metadata: { reason: 'invalid_password', locked },
      context,
    });
    throw invalidCredentials();
  }

  if (admin.status !== 'active') {
    await recordAuditIndependently({
      actor: { type: 'admin', id: admin.id },
      action: AuditAction.ADMIN_LOGIN_FAILED,
      severity: 'warning',
      outcome: 'failure',
      metadata: { reason: 'account_disabled' },
      context,
    });
    throw AppError.forbidden('This admin account has been disabled', ErrorCode.ACCOUNT_DISABLED);
  }

  const tokens = await sequelize.transaction(async (transaction) => {
    await Admin.update(
      { failedLoginAttempts: 0, lockedUntil: null, lastLoginAt: now },
      { where: { id: admin.id }, transaction },
    );
    const issued = await createSession(
      { subject: { type: 'admin', id: admin.id }, clientType: 'web', context },
      transaction,
    );
    await recordAudit(
      {
        actor: { type: 'admin', id: admin.id },
        action: AuditAction.ADMIN_LOGIN_SUCCEEDED,
        entityType: 'auth_session',
        entityId: issued.sessionId,
        context,
      },
      transaction,
    );
    return issued;
  });

  admin.lastLoginAt = now;
  return { tokens, admin: serializeAdmin(admin) };
}

export async function refreshAdminSession(refreshToken: string, context: RequestContext): Promise<IssuedTokens> {
  return rotateRefreshToken({
    refreshToken,
    subjectType: 'admin',
    clientType: 'web',
    context,
    assertSubjectAllowed: async (adminId, transaction) => {
      const admin = await Admin.findByPk(adminId, { attributes: ['id', 'status', 'isDeleted'], transaction });
      if (!admin || admin.isDeleted || admin.status !== 'active') {
        throw AppError.forbidden('This admin account has been disabled', ErrorCode.ACCOUNT_DISABLED);
      }
    },
  });
}

export async function logoutAdmin(refreshToken: string | null, context: RequestContext): Promise<void> {
  if (!refreshToken) return;
  const session = await findSessionByRefreshToken(refreshToken, 'admin', 'web');
  if (!session?.adminId || session.revokedAt) return;
  const adminId = session.adminId;

  await sequelize.transaction(async (transaction) => {
    if (!(await revokeSession(session.id, 'logout', transaction))) return;
    await recordAudit(
      {
        actor: { type: 'admin', id: adminId },
        action: AuditAction.ADMIN_LOGGED_OUT,
        entityType: 'auth_session',
        entityId: session.id,
        context,
      },
      transaction,
    );
  });
}

export async function getAdminProfile(adminId: string) {
  const admin = await Admin.findByPk(adminId);
  if (!admin || admin.isDeleted) throw AppError.unauthorized();
  const roles = (await getRolesHeldBy([admin.id])).get(admin.id) ?? [];
  return { ...serializeAdmin(admin), roles };
}

/**
 * Change the signed-in admin's own password. This is also how a staff member
 * replaces the generated password they were given: it clears the
 * "must change password" flag. Every other session is signed out.
 */
export async function changeAdminPassword(
  adminId: string,
  currentSessionId: string,
  input: { currentPassword: string; newPassword: string },
  context: RequestContext,
): Promise<{ revokedSessions: number }> {
  const admin = await Admin.scope('withSecrets').findOne({ where: { id: adminId, isDeleted: false } });
  if (!admin) throw AppError.unauthorized();

  if (!(await verifyPassword(admin.passwordHash, input.currentPassword))) {
    throw AppError.badRequest('Current password is incorrect', ErrorCode.CURRENT_PASSWORD_INCORRECT, [
      { path: 'currentPassword', message: 'Current password is incorrect' },
    ]);
  }
  if (input.newPassword === input.currentPassword) {
    throw AppError.unprocessable('New password must differ from your current password', ErrorCode.PASSWORD_REUSE, [
      { path: 'newPassword', message: 'New password must differ from your current password' },
    ]);
  }
  if (!passwordAvoidsIdentity(input.newPassword, { email: admin.email })) {
    throw AppError.unprocessable('Password must not contain your email', ErrorCode.VALIDATION_ERROR, [
      { path: 'newPassword', message: 'Password must not contain your email' },
    ]);
  }

  const passwordHash = await hashPassword(input.newPassword);

  return sequelize.transaction(async (transaction) => {
    await Admin.update(
      { passwordHash, passwordChangedAt: new Date(), mustChangePassword: false },
      { where: { id: adminId }, transaction },
    );
    const revokedSessions = await revokeAllAdminSessions(adminId, 'password_changed', transaction, currentSessionId);

    await recordAudit(
      {
        actor: { type: 'admin', id: adminId },
        action: AuditAction.ADMIN_PASSWORD_CHANGED,
        entityType: 'admin',
        entityId: adminId,
        severity: 'warning',
        metadata: { revokedSessions, firstSignIn: admin.mustChangePassword },
        context,
      },
      transaction,
    );
    return { revokedSessions };
  });
}
