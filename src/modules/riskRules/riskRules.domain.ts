import { Op, type Transaction } from 'sequelize';
import { sequelize } from '../../db/sequelize.js';
import type { ErrorDetail } from '../../common/errors/AppError.js';
import { formatMoney, formatPercent, toDecimal, type DecimalValue } from '../../common/utils/decimal.js';
import { RiskBand, RiskRuleSet, type Segment } from '../../models/index.js';
import type { RiskAcknowledgementLevel } from '../../models/enums.js';

/**
 * Capital-band risk rules.
 *
 * A segment's limits are a table of bands. A band applies from its
 * `capitalFrom` up to just below the next band's `capitalFrom`; the last band
 * has no upper end. Capital below the first band is not allowed.
 *
 * For a chosen risk % inside a band:
 *
 *   below minimum            -> blocked
 *   minimum .. suggested     -> allowed
 *   above suggested .. max   -> allowed after the caution disclaimer
 *   above max .. 100%        -> allowed after the strict disclaimer
 *   above 100%               -> blocked
 *
 * "Above" is strict: exactly the suggested or maximum value needs no
 * disclaimer for that level.
 */

/** Hard ceiling for any risk percentage, whatever the band. */
export const RISK_CEILING_PERCENT = '100';

export interface CurrentRules {
  ruleSet: RiskRuleSet;
  /** Sorted by capitalFrom, ascending. */
  bands: RiskBand[];
}

export type RiskLevel = 'below_minimum' | 'within' | 'above_suggested' | 'above_maximum' | 'above_ceiling';

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

function sortBands(bands: RiskBand[]): RiskBand[] {
  return [...bands].sort((a, b) => toDecimal(a.capitalFrom).comparedTo(toDecimal(b.capitalFrom)));
}

function toRules(ruleSet: RiskRuleSet): CurrentRules {
  return { ruleSet, bands: sortBands(ruleSet.bands ?? []) };
}

/**
 * The rule set in force (highest version) for each given segment. Segments
 * with no rule set are absent from the map.
 */
export async function loadCurrentRules(segmentIds: string[], transaction?: Transaction): Promise<Map<string, CurrentRules>> {
  if (segmentIds.length === 0) return new Map();
  const ruleSets = await RiskRuleSet.findAll({
    where: {
      segmentId: { [Op.in]: segmentIds },
      [Op.and]: [
        sequelize.literal(
          `"RiskRuleSet"."version" = (SELECT MAX(latest.version) FROM segment_risk_rule_sets latest WHERE latest.segment_id = "RiskRuleSet"."segment_id")`,
        ),
      ],
    },
    include: [{ model: RiskBand, as: 'bands' }],
    transaction,
  });
  return new Map(ruleSets.map((ruleSet) => [ruleSet.segmentId, toRules(ruleSet)]));
}

export async function loadRuleSetById(id: string, transaction?: Transaction): Promise<CurrentRules | null> {
  const ruleSet = await RiskRuleSet.findByPk(id, { include: [{ model: RiskBand, as: 'bands' }], transaction });
  return ruleSet ? toRules(ruleSet) : null;
}

export async function loadRuleSetByVersion(
  segmentId: string,
  version: number,
  transaction?: Transaction,
): Promise<CurrentRules | null> {
  const ruleSet = await RiskRuleSet.findOne({
    where: { segmentId, version },
    include: [{ model: RiskBand, as: 'bands' }],
    transaction,
  });
  return ruleSet ? toRules(ruleSet) : null;
}

// ---------------------------------------------------------------------------
// Band maths
// ---------------------------------------------------------------------------

/** Smallest capital any band accepts. */
export function minimumCapital(rules: CurrentRules): string {
  const first = rules.bands[0];
  return formatMoney(first ? first.capitalFrom : '0');
}

/** The band whose range contains `capital`, or null when it is below the first band. */
export function findBand(rules: CurrentRules, capital: string | DecimalValue): RiskBand | null {
  const value = toDecimal(capital.toString());
  let match: RiskBand | null = null;
  for (const band of rules.bands) {
    if (toDecimal(band.capitalFrom).lte(value)) match = band;
    else break;
  }
  return match;
}

/** Last capital inside the band at `index` (next band's start minus one paisa), or null for the last band. */
export function bandCapitalTo(rules: CurrentRules, index: number): string | null {
  const next = rules.bands[index + 1];
  return next ? formatMoney(toDecimal(next.capitalFrom).minus('0.01')) : null;
}

export function classifyRisk(band: Pick<RiskBand, 'minRiskPercent' | 'suggestedRiskPercent' | 'maxRiskPercent'>, riskPercent: string): RiskLevel {
  const value = toDecimal(riskPercent);
  if (value.lt(band.minRiskPercent)) return 'below_minimum';
  if (value.gt(RISK_CEILING_PERCENT)) return 'above_ceiling';
  if (value.gt(band.maxRiskPercent)) return 'above_maximum';
  if (value.gt(band.suggestedRiskPercent)) return 'above_suggested';
  return 'within';
}

/** The disclaimer a level needs, if any. */
export function acknowledgementFor(level: RiskLevel): RiskAcknowledgementLevel | null {
  if (level === 'above_suggested') return 'above_suggested';
  if (level === 'above_maximum') return 'above_maximum';
  return null;
}

/** Money at risk: capital x risk% / 100, to the paisa. */
export function riskAmount(capital: string, riskPercent: string): string {
  return formatMoney(toDecimal(capital).times(riskPercent).dividedBy(100).toDecimalPlaces(2));
}

/** (min + max) / 2, at the 4-decimal precision every percentage is stored with. */
export function midpointPercent(minPercent: string, maxPercent: string): string {
  return formatPercent(toDecimal(minPercent).plus(maxPercent).dividedBy(2).toDecimalPlaces(4));
}

// ---------------------------------------------------------------------------
// Violations (blocked values)
// ---------------------------------------------------------------------------

/** Capital must be > 0 and fall inside a band (at least the first band's capital). */
export function capitalViolation(segment: Segment, rules: CurrentRules, capital: string): ErrorDetail | null {
  const value = toDecimal(capital);
  const minimum = minimumCapital(rules);
  if (value.lte(0)) {
    return {
      path: 'capital',
      message: `Capital for ${segment.name} must be greater than 0`,
      segmentId: segment.id,
      minCapital: minimum,
    };
  }
  if (value.lt(minimum)) {
    return {
      path: 'capital',
      message: `Minimum capital for ${segment.name} is ${segment.currency} ${minimum}`,
      segmentId: segment.id,
      minCapital: minimum,
    };
  }
  return null;
}

/**
 * Risk below the band minimum or above the 100% ceiling is blocked. Values in
 * between are allowed (some only with a disclaimer, which is checked
 * separately). Returns null when the capital itself is out of range: that is
 * reported by capitalViolation.
 */
export function riskViolation(segment: Segment, rules: CurrentRules, capital: string, riskPercent: string): ErrorDetail | null {
  const band = findBand(rules, capital);
  if (!band) return null;
  const level = classifyRisk(band, riskPercent);
  if (level !== 'below_minimum' && level !== 'above_ceiling') return null;
  const min = toDecimal(band.minRiskPercent);
  return {
    path: 'riskPercent',
    message:
      level === 'below_minimum'
        ? `Risk for ${segment.name} with this capital must be at least ${min.toString()}%`
        : `Risk for ${segment.name} cannot be more than ${RISK_CEILING_PERCENT}%`,
    segmentId: segment.id,
    reason: level,
    minRiskPercent: formatPercent(min),
    suggestedRiskPercent: formatPercent(band.suggestedRiskPercent),
    maxRiskPercent: formatPercent(band.maxRiskPercent),
    ceilingPercent: formatPercent(RISK_CEILING_PERCENT),
  };
}

// ---------------------------------------------------------------------------
// Serialisation
// ---------------------------------------------------------------------------

export function serializeBand(band: RiskBand, capitalTo: string | null) {
  return {
    capitalFrom: formatMoney(band.capitalFrom),
    capitalTo,
    minRiskPercent: formatPercent(band.minRiskPercent),
    suggestedRiskPercent: formatPercent(band.suggestedRiskPercent),
    maxRiskPercent: formatPercent(band.maxRiskPercent),
  };
}

export type SerializedBand = ReturnType<typeof serializeBand>;

export function serializeRules(rules: CurrentRules) {
  return {
    ruleSetId: rules.ruleSet.id,
    version: rules.ruleSet.version,
    suggestedMode: rules.ruleSet.suggestedMode,
    minCapital: minimumCapital(rules),
    ceilingPercent: formatPercent(RISK_CEILING_PERCENT),
    effectiveFrom: rules.ruleSet.createdAt,
    bands: rules.bands.map((band, index) => serializeBand(band, bandCapitalTo(rules, index))),
  };
}

export type SerializedRules = ReturnType<typeof serializeRules>;

/** The serialized band (with its upper end) that contains `capital`, or null. */
export function serializedBandFor(rules: CurrentRules, capital: string): SerializedBand | null {
  const band = findBand(rules, capital);
  if (!band) return null;
  return serializeBand(band, bandCapitalTo(rules, rules.bands.indexOf(band)));
}

// ---------------------------------------------------------------------------
// Differences between versions
// ---------------------------------------------------------------------------

export type BandValues = Pick<SerializedBand, 'minRiskPercent' | 'suggestedRiskPercent' | 'maxRiskPercent'>;

export function bandValues(band: SerializedBand | null): BandValues | null {
  return band
    ? {
        minRiskPercent: band.minRiskPercent,
        suggestedRiskPercent: band.suggestedRiskPercent,
        maxRiskPercent: band.maxRiskPercent,
      }
    : null;
}

export function sameValues(a: BandValues | null, b: BandValues | null): boolean {
  return (
    a !== null &&
    b !== null &&
    toDecimal(a.minRiskPercent).eq(b.minRiskPercent) &&
    toDecimal(a.suggestedRiskPercent).eq(b.suggestedRiskPercent) &&
    toDecimal(a.maxRiskPercent).eq(b.maxRiskPercent)
  );
}

/** Band-by-band differences between two versions, keyed by starting capital. */
export function bandChanges(fromRules: CurrentRules | null, toRules: CurrentRules) {
  const serialize = (rules: CurrentRules) =>
    rules.bands.map((band, index) => serializeBand(band, bandCapitalTo(rules, index)));
  const before = new Map((fromRules ? serialize(fromRules) : []).map((band) => [band.capitalFrom, band]));
  const after = new Map(serialize(toRules).map((band) => [band.capitalFrom, band]));
  const capitals = [...new Set([...before.keys(), ...after.keys()])].sort((a, b) => toDecimal(a).comparedTo(toDecimal(b)));
  return capitals.flatMap((capitalFrom) => {
    const old = before.get(capitalFrom) ?? null;
    const now = after.get(capitalFrom) ?? null;
    if (old && now && sameValues(old, now)) return [];
    return [
      {
        change: old && now ? ('changed' as const) : now ? ('added' as const) : ('removed' as const),
        capitalFrom,
        before: bandValues(old),
        after: bandValues(now),
      },
    ];
  });
}

/**
 * Whether two versions give a customer exactly the same limits: the same
 * bands (starting capital, minimum, suggested and maximum), and so the same
 * minimum capital. A change that ends up where the customer already was
 * (for example an admin undoing an edit) leaves nothing to accept.
 */
export function sameLimits(fromRules: CurrentRules | null, toRules: CurrentRules): boolean {
  return fromRules !== null && bandChanges(fromRules, toRules).length === 0;
}
