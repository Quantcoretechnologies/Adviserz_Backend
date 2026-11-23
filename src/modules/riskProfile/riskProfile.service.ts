import type { Transaction } from 'sequelize';
import { sequelize } from '../../db/sequelize.js';
import { AppError } from '../../common/errors/AppError.js';
import { ErrorCode } from '../../common/errors/errorCodes.js';
import type { RequestContext } from '../../common/http/requestContext.js';
import { formatMoney, formatPercent, toDecimal } from '../../common/utils/decimal.js';
import { toPagination } from '../../common/utils/validation.js';
import { RiskProfile, RiskProfileSegment, User } from '../../models/index.js';
import type { MarketExperience, RiskProfileSource } from '../../models/enums.js';
import { recordAudit } from '../audit/audit.service.js';
import { AuditAction } from '../audit/auditActions.js';
import {
  assess,
  loadAcknowledgements,
  recordAcknowledgements,
  settleChoices,
  type AcknowledgementInput,
} from '../riskRules/riskAcknowledgement.service.js';
import { capitalViolation, riskViolation } from '../riskRules/riskRules.domain.js';
import { loadSelectableSegments, type SegmentWithRules } from '../segments/segment.service.js';
import { findProfile, findProfiles, serializeRiskProfile, throwIfViolations } from './riskProfile.domain.js';

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

export interface RiskAllocationInput {
  segmentId: string;
  capital: string;
  riskPercent: string;
  acknowledgement?: AcknowledgementInput | undefined;
}

export interface RiskProfileUpdate {
  marketExperience: MarketExperience;
  allocations: RiskAllocationInput[];
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

export function getLoadedSegment(segments: Map<string, SegmentWithRules>, segmentId: string): SegmentWithRules {
  const loaded = segments.get(segmentId);
  if (!loaded) throw new Error(`Segment ${segmentId} not loaded`);
  return loaded;
}

/** Reject capital below the band minimum, and risk below the band minimum or above 100%. */
export function assertAllocationsInRange(
  segments: Map<string, SegmentWithRules>,
  allocations: { segmentId: string; capital: string; riskPercent: string }[],
): void {
  throwIfViolations(
    allocations.map((item) => {
      const { segment, rules } = getLoadedSegment(segments, item.segmentId);
      return capitalViolation(segment, rules, item.capital);
    }),
    ErrorCode.CAPITAL_BELOW_MINIMUM,
    'Capital is below the minimum for one or more segments',
  );
  throwIfViolations(
    allocations.map((item) => {
      const { segment, rules } = getLoadedSegment(segments, item.segmentId);
      return riskViolation(segment, rules, item.capital, item.riskPercent);
    }),
    ErrorCode.RISK_OUT_OF_RANGE,
    'Risk is outside the allowed range for one or more segments',
  );
}

export interface NewProfileRow {
  segmentId: string;
  riskBasis: RiskProfileSegment['riskBasis'];
  currency: string;
  capital: string;
  riskPercent: string;
  ruleSetId: string | null;
  riskAcknowledgementId: string | null;
}

/**
 * Supersede the active profile and insert the next active version. History is
 * never overwritten. The caller holds the user row lock.
 */
export async function createNextActiveVersion(
  params: {
    userId: string;
    current: RiskProfile;
    marketExperience: MarketExperience;
    source: RiskProfileSource;
    rows: (Omit<NewProfileRow, 'riskAcknowledgementId'> & { riskAcknowledgementId?: string | null })[];
  },
  transaction: Transaction,
): Promise<RiskProfile> {
  const now = new Date();
  // Supersede first: the partial unique index allows one active profile.
  await RiskProfile.update(
    { status: 'superseded', supersededAt: now },
    { where: { id: params.current.id }, transaction },
  );
  const maxVersion = (await RiskProfile.max<number | null, RiskProfile>('version', {
    where: { userId: params.userId },
    transaction,
  })) as number | null;
  const next = await RiskProfile.create(
    {
      userId: params.userId,
      version: (maxVersion ?? params.current.version) + 1,
      status: 'active',
      source: params.source,
      marketExperience: params.marketExperience,
      brokerStepStatus: params.current.brokerStepStatus,
      confirmedAt: now,
    },
    { transaction },
  );
  await RiskProfileSegment.bulkCreate(
    params.rows.map((row) => ({
      riskProfileId: next.id,
      segmentId: row.segmentId,
      riskBasis: row.riskBasis,
      currency: row.currency,
      capital: formatMoney(row.capital),
      riskPercent: formatPercent(row.riskPercent),
      ruleSetId: row.ruleSetId,
      riskAcknowledgementId: row.riskAcknowledgementId ?? null,
    })),
    { transaction },
  );
  return next;
}

/**
 * Edit the risk profile after onboarding. Same rules as onboarding: values
 * must fit the bands in force, and a risk above the suggested or maximum
 * level needs its disclaimer accepted (an acknowledgement already on record
 * for the very same values still counts, e.g. when only the market experience
 * changes). History is preserved: the active version is superseded and a new
 * one inserted, in one transaction serialised by the user row lock.
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
    assertAllocationsInRange(segments, input.allocations);

    const current = await findProfile({ userId, status: 'active' }, transaction);
    if (!current) throw AppError.notFound('No active risk profile');
    // An identical resubmission must not add a version to the history.
    if (isUnchanged(current, input)) {
      throw AppError.unprocessable('Your risk profile is unchanged', ErrorCode.NO_CHANGES);
    }

    const currentRows = new Map((current.segments ?? []).map((row) => [row.segmentId, row]));
    const existingAcks = await loadAcknowledgements(
      [...currentRows.values()].map((row) => row.riskAcknowledgementId),
      transaction,
    );
    const settled = await settleChoices(
      input.allocations.map((item) => {
        const { segment, rules } = getLoadedSegment(segments, item.segmentId);
        const assessment = assess(segment, rules, item.capital, item.riskPercent);
        if (!assessment) throw new Error('Capital was checked against the bands above');
        const previous = currentRows.get(item.segmentId);
        return {
          assessment,
          acknowledgement: item.acknowledgement,
          existing: existingAcks.get(previous?.riskAcknowledgementId ?? ''),
          previousCapital: previous?.capital ?? null,
          previousRiskPercent: previous?.riskPercent ?? null,
        };
      }),
      transaction,
    );

    const next = await createNextActiveVersion(
      {
        userId,
        current,
        marketExperience: input.marketExperience,
        source: 'profile_update',
        rows: settled.map(({ assessment }) => ({
          segmentId: assessment.segment.id,
          riskBasis: assessment.segment.riskBasis,
          currency: assessment.segment.currency,
          capital: assessment.capital,
          riskPercent: assessment.riskPercent,
          ruleSetId: assessment.rules.ruleSet.id,
        })),
      },
      transaction,
    );
    const covering = await recordAcknowledgements(
      settled,
      { userId, riskProfileId: next.id, source: 'profile_update', context },
      transaction,
    );
    for (const [segmentId, ackId] of covering) {
      await RiskProfileSegment.update(
        { riskAcknowledgementId: ackId },
        { where: { riskProfileId: next.id, segmentId, isDeleted: false }, transaction },
      );
    }

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
