import { z } from 'zod';
import type { Transaction, WhereOptions } from 'sequelize';
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

/** Capital must be > 0 and at least the segment's admin-configured minimum. */
export function capitalViolation(segment: Segment, capital: string): ErrorDetail | null {
  const value = toDecimal(capital);
  const minimum = toDecimal(segment.minCapital);
  if (value.lte(0)) {
    return {
      path: 'capital',
      message: `Capital for ${segment.name} must be greater than 0`,
      segmentId: segment.id,
      minCapital: formatMoney(minimum),
    };
  }
  if (value.lt(minimum)) {
    return {
      path: 'capital',
      message: `Minimum capital for ${segment.name} is ${segment.currency} ${formatMoney(minimum)}`,
      segmentId: segment.id,
      minCapital: formatMoney(minimum),
    };
  }
  return null;
}

/** Risk % must fall inside the segment's admin-configured range. */
export function riskViolation(segment: Segment, riskPercent: string): ErrorDetail | null {
  const value = toDecimal(riskPercent);
  const min = toDecimal(segment.minRiskPercent);
  const max = toDecimal(segment.maxRiskPercent);
  if (value.lt(min) || value.gt(max)) {
    return {
      path: 'riskPercent',
      // Human-readable bounds ("0.01% and 100%"); the exact fixed-scale values are in the fields below.
      message: `Risk for ${segment.name} must be between ${min.toString()}% and ${max.toString()}%`,
      segmentId: segment.id,
      minRiskPercent: formatPercent(min),
      maxRiskPercent: formatPercent(max),
    };
  }
  return null;
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
    include: [{ model: Segment, as: 'segment' }],
  },
];

export async function findProfile(
  where: WhereOptions<RiskProfile>,
  transaction?: Transaction,
): Promise<RiskProfile | null> {
  return RiskProfile.findOne({
    where,
    include: PROFILE_INCLUDE,
    order: [[{ model: RiskProfileSegment, as: 'segments' }, 'createdAt', 'ASC']],
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
    order: [
      ['version', 'DESC'],
      [{ model: RiskProfileSegment, as: 'segments' }, 'createdAt', 'ASC'],
    ],
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
