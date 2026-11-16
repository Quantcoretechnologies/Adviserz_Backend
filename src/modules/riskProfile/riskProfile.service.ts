import { sequelize } from '../../db/sequelize.js';
import { AppError } from '../../common/errors/AppError.js';
import { ErrorCode } from '../../common/errors/errorCodes.js';
import type { RequestContext } from '../../common/http/requestContext.js';
import { formatMoney, formatPercent, toDecimal } from '../../common/utils/decimal.js';
import { toPagination } from '../../common/utils/validation.js';
import { RiskProfile, RiskProfileSegment, User } from '../../models/index.js';
import type { MarketExperience } from '../../models/enums.js';
import { recordAudit } from '../audit/audit.service.js';
import { AuditAction } from '../audit/auditActions.js';
import { loadSelectableSegments } from '../segments/segment.service.js';
import {
  capitalViolation,
  findProfile,
  findProfiles,
  riskViolation,
  serializeRiskProfile,
  throwIfViolations,
} from './riskProfile.domain.js';

export async function getActiveRiskProfile(userId: string) {
  const profile = await findProfile({ userId, status: 'active' });
  if (!profile) throw AppError.notFound('No active risk profile');
  return serializeRiskProfile(profile);
}

/** All confirmed versions, newest first (drafts are excluded). */
export async function getRiskProfileHistory(userId: string, page: number, pageSize: number) {
  const { rows, count } = await findProfiles(
    { userId, status: ['active', 'superseded'] },
    { limit: pageSize, offset: (page - 1) * pageSize },
  );
  return { items: rows.map(serializeRiskProfile), pagination: toPagination(page, pageSize, count) };
}

export interface RiskProfileUpdate {
  marketExperience: MarketExperience;
  allocations: { segmentId: string; capital: string; riskPercent: string }[];
}

/**
 * True when the update would reproduce the active profile exactly: same
 * experience and the same set of segments with numerically equal capital and
 * risk ("100000" equals "100000.00"). Order of allocations is irrelevant.
 */
function isUnchanged(current: RiskProfile, input: RiskProfileUpdate): boolean {
  const rows = current.segments ?? [];
  if (current.marketExperience !== input.marketExperience || rows.length !== input.allocations.length) return false;
  const bySegment = new Map(rows.map((row) => [row.segmentId, row]));
  return input.allocations.every((item) => {
    const row = bySegment.get(item.segmentId);
    return (
      row !== undefined &&
      row.capital !== null &&
      row.riskPercent !== null &&
      toDecimal(row.capital).eq(toDecimal(item.capital)) &&
      toDecimal(row.riskPercent).eq(toDecimal(item.riskPercent))
    );
  });
}

/**
 * Edit the risk profile after onboarding. History is preserved: the current
 * active version is marked superseded and a new active version is inserted,
 * in one transaction serialised by the user row lock.
 */
export async function updateRiskProfile(userId: string, input: RiskProfileUpdate, context: RequestContext) {
  const newProfileId = await sequelize.transaction(async (transaction) => {
    const user = await User.findByPk(userId, { lock: transaction.LOCK.UPDATE, transaction });
    if (!user) throw AppError.unauthorized();
    if (user.onboardingStatus !== 'completed') {
      throw AppError.forbidden('Please complete onboarding to continue', ErrorCode.ONBOARDING_REQUIRED);
    }

    const segments = await loadSelectableSegments(
      input.allocations.map((item) => item.segmentId),
      transaction,
    );
    throwIfViolations(
      input.allocations.map((item) => {
        const segment = segments.get(item.segmentId);
        return segment ? capitalViolation(segment, item.capital) : null;
      }),
      ErrorCode.CAPITAL_BELOW_MINIMUM,
      'Capital is below the minimum for one or more segments',
    );
    throwIfViolations(
      input.allocations.map((item) => {
        const segment = segments.get(item.segmentId);
        return segment ? riskViolation(segment, item.riskPercent) : null;
      }),
      ErrorCode.RISK_OUT_OF_RANGE,
      'Risk is outside the allowed range for one or more segments',
    );

    const current = await findProfile({ userId, status: 'active' }, transaction);
    if (!current) throw AppError.notFound('No active risk profile');
    // An identical resubmission must not add a version to the history.
    if (isUnchanged(current, input)) {
      throw AppError.unprocessable('Your risk profile is unchanged', ErrorCode.NO_CHANGES);
    }

    const now = new Date();
    // Supersede first: the partial unique index allows one active profile.
    await RiskProfile.update(
      { status: 'superseded', supersededAt: now },
      { where: { id: current.id }, transaction },
    );

    const maxVersion = (await RiskProfile.max<number | null, RiskProfile>('version', {
      where: { userId },
      transaction,
    })) as number | null;
    const next = await RiskProfile.create(
      {
        userId,
        version: (maxVersion ?? current.version) + 1,
        status: 'active',
        source: 'profile_update',
        marketExperience: input.marketExperience,
        brokerStepStatus: current.brokerStepStatus,
        confirmedAt: now,
      },
      { transaction },
    );

    await RiskProfileSegment.bulkCreate(
      input.allocations.map((item) => {
        const segment = segments.get(item.segmentId);
        if (!segment) throw new Error(`Segment ${item.segmentId} not loaded`);
        return {
          riskProfileId: next.id,
          segmentId: item.segmentId,
          riskBasis: segment.riskBasis,
          currency: segment.currency,
          capital: formatMoney(item.capital),
          riskPercent: formatPercent(item.riskPercent),
        };
      }),
      { transaction },
    );

    const created = await findProfile({ id: next.id }, transaction);
    await recordAudit(
      {
        actor: { type: 'user', id: userId },
        action: AuditAction.RISK_PROFILE_UPDATED,
        entityType: 'risk_profile',
        entityId: next.id,
        subjectUserId: userId,
        before: serializeRiskProfile(current),
        after: created ? serializeRiskProfile(created) : { id: next.id },
        context,
      },
      transaction,
    );

    return next.id;
  });

  const profile = await findProfile({ id: newProfileId });
  if (!profile) throw new Error('Updated risk profile could not be reloaded');
  return serializeRiskProfile(profile);
}
