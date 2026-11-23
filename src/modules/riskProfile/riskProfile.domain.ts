import { z } from 'zod';
import type { OrderItem, Transaction, WhereOptions } from 'sequelize';
import { AppError, type ErrorDetail } from '../../common/errors/AppError.js';
import { ErrorCode } from '../../common/errors/errorCodes.js';
import { formatMoney, formatPercent, toDecimal } from '../../common/utils/decimal.js';
import { decimalString } from '../../common/utils/validation.js';
import { RiskProfile, RiskProfileSegment, Segment } from '../../models/index.js';
import { MARKET_EXPERIENCES } from '../../models/enums.js';

/**
 * Rules shared by onboarding and post-onboarding profile edits.
 */

export const marketExperienceSchema = z.enum(MARKET_EXPERIENCES, {
  error: `Market experience must be one of: ${MARKET_EXPERIENCES.join(', ')}`,
});

export const capitalSchema = decimalString(2, 'Capital');
export const riskPercentSchema = decimalString(4, 'Risk percentage');

/** Reject duplicate segment ids in an array of `{ segmentId }`. */
export function uniqueSegmentIds<T extends { segmentId: string }>(items: T[]): boolean {
  return new Set(items.map((item) => item.segmentId)).size === items.length;
}

export function throwIfViolations(violations: (ErrorDetail | null)[], code: ErrorCode, message: string): void {
  const details = violations.filter((item): item is ErrorDetail => item !== null);
  if (details.length > 0) throw AppError.unprocessable(message, code, details);
}

/** The submitted allocations must cover exactly the selected segments. */
export function assertExactSegmentSet(selected: string[], provided: string[]): void {
  const selectedSet = new Set(selected);
  const providedSet = new Set(provided);
  const missing = selected.filter((id) => !providedSet.has(id));
  const unexpected = provided.filter((id) => !selectedSet.has(id));
  if (missing.length > 0 || unexpected.length > 0) {
    throw AppError.unprocessable('Values must be provided for exactly the selected segments', ErrorCode.VALIDATION_ERROR, [
      ...missing.map((id) => ({ path: 'allocations', message: 'Missing value for selected segment', segmentId: id })),
      ...unexpected.map((id) => ({ path: 'allocations', message: 'Segment is not selected', segmentId: id })),
    ]);
  }
}

// ---------------------------------------------------------------------------
// Loading & serialisation
// ---------------------------------------------------------------------------

const PROFILE_INCLUDE = [
  {
    model: RiskProfileSegment,
    as: 'segments',
    where: { isDeleted: false },
    // A `where` on an include turns it into an INNER JOIN by default; keep
    // profiles that have no live segment rows (a fresh onboarding draft).
    required: false,
    include: [{ model: Segment, as: 'segment' }],
  },
];

/**
 * A profile's segments in the segment list's own order. Rows saved together
 * share a timestamp, so ordering by time alone let them swap between reads.
 */
const SEGMENT_ORDER: OrderItem[] = [
  [{ model: RiskProfileSegment, as: 'segments' }, { model: Segment, as: 'segment' }, 'displayOrder', 'ASC'],
  [{ model: RiskProfileSegment, as: 'segments' }, { model: Segment, as: 'segment' }, 'name', 'ASC'],
];

export async function findProfile(
  where: WhereOptions<RiskProfile>,
  transaction?: Transaction,
): Promise<RiskProfile | null> {
  return RiskProfile.findOne({
    where,
    include: PROFILE_INCLUDE,
    order: SEGMENT_ORDER,
    transaction,
  });
}

export async function findProfiles(
  where: WhereOptions<RiskProfile>,
  options: { limit: number; offset: number },
): Promise<{ rows: RiskProfile[]; count: number }> {
  return RiskProfile.findAndCountAll({
    where,
    include: PROFILE_INCLUDE,
    order: [['version', 'DESC'], ...SEGMENT_ORDER],
    limit: options.limit,
    offset: options.offset,
    distinct: true,
  });
}

export function serializeProfileSegment(row: RiskProfileSegment) {
  return {
    segmentId: row.segmentId,
    code: row.segment?.code ?? null,
    name: row.segment?.name ?? null,
    riskBasis: row.riskBasis,
    currency: row.currency,
    capital: row.capital === null ? null : formatMoney(row.capital),
    riskPercent: row.riskPercent === null ? null : formatPercent(row.riskPercent),
    ruleSetId: row.ruleSetId,
    riskAcknowledgementId: row.riskAcknowledgementId,
  };
}

export function serializeRiskProfile(profile: RiskProfile) {
  const segments = (profile.segments ?? []).map(serializeProfileSegment);

  // Total only when every segment has capital and all share one currency.
  const currencies = new Set(segments.map((segment) => segment.currency));
  const complete = segments.length > 0 && segments.every((segment) => segment.capital !== null);
  const totalCapital =
    complete && currencies.size === 1
      ? formatMoney(segments.reduce((sum, segment) => sum.plus(segment.capital ?? '0'), toDecimal(0)))
      : null;

  return {
    id: profile.id,
    version: profile.version,
    status: profile.status,
    source: profile.source,
    marketExperience: profile.marketExperience,
    confirmedAt: profile.confirmedAt,
    supersededAt: profile.supersededAt,
    createdAt: profile.createdAt,
    segments,
    totalCapital,
    currency: currencies.size === 1 ? [...currencies][0] : null,
  };
}
