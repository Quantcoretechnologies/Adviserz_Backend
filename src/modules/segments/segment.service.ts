import { Op, type Transaction } from 'sequelize';
import { AppError } from '../../common/errors/AppError.js';
import { ErrorCode } from '../../common/errors/errorCodes.js';
import { Segment } from '../../models/index.js';
import { loadCurrentRules, serializeRules, type CurrentRules } from '../riskRules/riskRules.domain.js';

/** A segment together with the risk bands in force for it. */
export interface SegmentWithRules {
  segment: Segment;
  rules: CurrentRules;
}

/**
 * `minCapital` is the first band's capital. `riskRules` carries every band so
 * clients can show the range for the user's capital and warn before saving.
 */
export function serializeSegment(segment: Segment, rules: CurrentRules | null) {
  const serializedRules = rules ? serializeRules(rules) : null;
  return {
    id: segment.id,
    code: segment.code,
    name: segment.name,
    description: segment.description,
    riskBasis: segment.riskBasis,
    minCapital: serializedRules?.minCapital ?? null,
    currency: segment.currency,
    isActive: segment.isActive,
    displayOrder: segment.displayOrder,
    suggestedMode: segment.suggestedMode,
    riskRules: serializedRules,
  };
}

export type SerializedSegment = ReturnType<typeof serializeSegment>;

/**
 * Active segments users can choose. A segment without risk bands yet is not
 * offered: its limits are unknown.
 */
export async function listActiveSegments(transaction?: Transaction): Promise<SegmentWithRules[]> {
  const segments = await Segment.findAll({
    where: { isActive: true },
    order: [['displayOrder', 'ASC'], ['name', 'ASC']],
    transaction,
  });
  const rules = await loadCurrentRules(
    segments.map((segment) => segment.id),
    transaction,
  );
  return segments.flatMap((segment) => {
    const current = rules.get(segment.id);
    return current ? [{ segment, rules: current }] : [];
  });
}

export function serializeSegmentWithRules({ segment, rules }: SegmentWithRules) {
  return serializeSegment(segment, rules);
}

/**
 * Resolve segment ids that a user is selecting. Every id must exist, be active
 * and have risk bands; otherwise SEGMENT_NOT_AVAILABLE lists the offending ids.
 */
export async function loadSelectableSegments(
  ids: string[],
  transaction?: Transaction,
): Promise<Map<string, SegmentWithRules>> {
  const segments = await Segment.findAll({ where: { id: { [Op.in]: ids }, isActive: true }, transaction });
  const rules = await loadCurrentRules(
    segments.map((segment) => segment.id),
    transaction,
  );
  const byId = new Map<string, SegmentWithRules>();
  for (const segment of segments) {
    const current = rules.get(segment.id);
    if (current) byId.set(segment.id, { segment, rules: current });
  }
  const unavailable = ids.filter((id) => !byId.has(id));
  if (unavailable.length > 0) {
    throw AppError.unprocessable(
      'One or more selected segments are not available',
      ErrorCode.SEGMENT_NOT_AVAILABLE,
      unavailable.map((id) => ({ path: 'segmentId', message: 'Segment is not available', segmentId: id })),
    );
  }
  return byId;
}
