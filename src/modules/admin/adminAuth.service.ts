import { env } from '../../config/env.js';
import { sequelize } from '../../db/sequelize.js';
import { AppError } from '../../common/errors/AppError.js';
import { ErrorCode } from '../../common/errors/errorCodes.js';
import type { RequestContext } from '../../common/http/requestContext.js';
import { burnPasswordVerification, verifyPassword } from '../../common/utils/password.js';
import { Admin } from '../../models/index.js';
import { recordAudit, recordAuditIndependently } from '../audit/audit.service.js';
import { AuditAction } from '../audit/auditActions.js';
import {
  createSession,
  findSessionByRefreshToken,
  revokeSession,
  rotateRefreshToken,
  type IssuedTokens,
} from '../auth/session.service.js';

export function serializeAdmin(admin: Admin) {
  return {
    id: admin.id,
    fullName: admin.fullName,
    email: admin.email,
    role: admin.role,
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
  const admin = await Admin.scope('withSecrets').findOne({ where: { email } });

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
      const admin = await Admin.findByPk(adminId, { attributes: ['id', 'status'], transaction });
      if (!admin || admin.status !== 'active') {
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
  if (!admin) throw AppError.unauthorized();
  return serializeAdmin(admin);
}
