import { Op, type WhereOptions } from 'sequelize';
import { sequelize } from '../../db/sequelize.js';
import { AppError } from '../../common/errors/AppError.js';
import { ErrorCode } from '../../common/errors/errorCodes.js';
import type { RequestContext } from '../../common/http/requestContext.js';
import { toPagination } from '../../common/utils/validation.js';
import { AuthSession, PolicyAcceptance, PolicyDocument, User } from '../../models/index.js';
import type { OnboardingStatus, UserStatus } from '../../models/enums.js';
import { recordAudit } from '../audit/audit.service.js';
import { AuditAction } from '../audit/auditActions.js';
import { revokeAllUserSessions } from '../auth/session.service.js';
import { getPendingPolicies, serializePolicy } from '../policies/policy.service.js';
import { findProfile, findProfiles, serializeRiskProfile } from '../riskProfile/riskProfile.domain.js';
import { serializeUser } from '../users/user.serializer.js';

function serializeAdminUserView(user: User) {
  return {
    ...serializeUser(user),
    blockedAt: user.blockedAt,
    blockedReason: user.blockedReason,
    failedLoginAttempts: user.failedLoginAttempts,
    lockedUntil: user.lockedUntil,
    passwordChangedAt: user.passwordChangedAt,
    updatedAt: user.updatedAt,
  };
}

/** Escape LIKE wildcards so user input is matched literally. */
function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

export async function listUsers(query: {
  page: number;
  pageSize: number;
  search?: string | undefined;
  status?: UserStatus | undefined;
  onboardingStatus?: OnboardingStatus | undefined;
  sortOrder: 'asc' | 'desc';
}) {
  const where: WhereOptions<User> = {
    ...(query.status ? { status: query.status } : {}),
    ...(query.onboardingStatus ? { onboardingStatus: query.onboardingStatus } : {}),
    ...(query.search
      ? {
          [Op.or]: [
            { fullName: { [Op.iLike]: likePattern(query.search) } },
            { username: { [Op.iLike]: likePattern(query.search) } },
            { email: { [Op.iLike]: likePattern(query.search) } },
            { phone: { [Op.iLike]: likePattern(query.search) } },
          ],
        }
      : {}),
  };

  const { rows, count } = await User.findAndCountAll({
    where,
    order: [['createdAt', query.sortOrder.toUpperCase()]],
    limit: query.pageSize,
    offset: (query.page - 1) * query.pageSize,
  });

  return {
    items: rows.map(serializeAdminUserView),
    pagination: toPagination(query.page, query.pageSize, count),
  };
}

export async function getUserDetail(userId: string) {
  const user = await User.findByPk(userId);
  if (!user) throw AppError.notFound('User not found');

  const [activeProfile, draft, activeSessions, acceptances, pendingPolicies] = await Promise.all([
    findProfile({ userId, status: 'active' }),
    findProfile({ userId, status: 'draft' }),
    AuthSession.count({ where: { userId, revokedAt: null, expiresAt: { [Op.gt]: new Date() } } }),
    PolicyAcceptance.findAll({
      where: { userId },
      include: [{ model: PolicyDocument, as: 'policyDocument' }],
      order: [['acceptedAt', 'DESC']],
    }),
    getPendingPolicies(userId),
  ]);

  return {
    user: serializeAdminUserView(user),
    activeRiskProfile: activeProfile ? serializeRiskProfile(activeProfile) : null,
    onboardingDraft: draft ? serializeRiskProfile(draft) : null,
    activeSessions,
    policyAcceptances: acceptances.map((row) => {
      const doc = (row as PolicyAcceptance & { policyDocument?: PolicyDocument }).policyDocument;
      return {
        id: row.id,
        acceptedAt: row.acceptedAt,
        ipAddress: row.ipAddress,
        policy: doc ? serializePolicy(doc, { includeContent: false }) : null,
      };
    }),
    pendingPolicies: pendingPolicies.map((doc) => serializePolicy(doc, { includeContent: false })),
  };
}

export async function getUserRiskProfileHistory(userId: string, page: number, pageSize: number) {
  if (!(await User.count({ where: { id: userId } }))) throw AppError.notFound('User not found');
  const { rows, count } = await findProfiles(
    { userId, status: ['active', 'superseded'] },
    { limit: pageSize, offset: (page - 1) * pageSize },
  );
  return { items: rows.map(serializeRiskProfile), pagination: toPagination(page, pageSize, count) };
}

/** Block an account and sign it out of every device immediately. */
export async function blockUser(adminId: string, userId: string, reason: string, context: RequestContext) {
  const user = await sequelize.transaction(async (transaction) => {
    const target = await User.findByPk(userId, { lock: transaction.LOCK.UPDATE, transaction });
    if (!target) throw AppError.notFound('User not found');
    if (target.status === 'blocked') throw AppError.conflict('User is already blocked');

    target.status = 'blocked';
    target.blockedAt = new Date();
    target.blockedReason = reason;
    target.blockedByAdminId = adminId;
    await target.save({ transaction });

    const revokedSessions = await revokeAllUserSessions(userId, 'account_blocked', transaction);

    await recordAudit(
      {
        actor: { type: 'admin', id: adminId },
        action: AuditAction.ADMIN_USER_BLOCKED,
        entityType: 'user',
        entityId: userId,
        subjectUserId: userId,
        severity: 'critical',
        before: { status: 'active' },
        after: { status: 'blocked', reason },
        metadata: { revokedSessions },
        context,
      },
      transaction,
    );
    return target;
  });
  return serializeAdminUserView(user);
}

export async function unblockUser(adminId: string, userId: string, context: RequestContext) {
  const user = await sequelize.transaction(async (transaction) => {
    const target = await User.findByPk(userId, { lock: transaction.LOCK.UPDATE, transaction });
    if (!target) throw AppError.notFound('User not found');
    if (target.status !== 'blocked') throw AppError.conflict('User is not blocked', ErrorCode.CONFLICT);

    const previousReason = target.blockedReason;
    target.status = 'active';
    target.blockedAt = null;
    target.blockedReason = null;
    target.blockedByAdminId = null;
    target.failedLoginAttempts = 0;
    target.lockedUntil = null;
    await target.save({ transaction });

    await recordAudit(
      {
        actor: { type: 'admin', id: adminId },
        action: AuditAction.ADMIN_USER_UNBLOCKED,
        entityType: 'user',
        entityId: userId,
        subjectUserId: userId,
        severity: 'warning',
        before: { status: 'blocked', reason: previousReason },
        after: { status: 'active' },
        context,
      },
      transaction,
    );
    return target;
  });
  return serializeAdminUserView(user);
}
