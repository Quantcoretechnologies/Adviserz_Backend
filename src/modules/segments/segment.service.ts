import { Op, type Transaction } from 'sequelize';
import { AppError } from '../../common/errors/AppError.js';
import { ErrorCode } from '../../common/errors/errorCodes.js';
import { formatMoney, formatPercent } from '../../common/utils/decimal.js';
import { Segment } from '../../models/index.js';

export function serializeSegment(segment: Segment) {
  return {
    id: segment.id,
    code: segment.code,
    name: segment.name,
    description: segment.description,
    riskBasis: segment.riskBasis,
    minCapital: formatMoney(segment.minCapital),
    minRiskPercent: formatPercent(segment.minRiskPercent),
    maxRiskPercent: formatPercent(segment.maxRiskPercent),
    currency: segment.currency,
    isActive: segment.isActive,
    displayOrder: segment.displayOrder,
  };
}

export type SerializedSegment = ReturnType<typeof serializeSegment>;

export async function listActiveSegments(): Promise<Segment[]> {
  return Segment.findAll({ where: { isActive: true }, order: [['displayOrder', 'ASC'], ['name', 'ASC']] });
}

/**
 * Resolve segment ids that a user is selecting. Every id must exist and be
 * active; otherwise SEGMENT_NOT_AVAILABLE lists the offending ids.
 */
export async function loadSelectableSegments(ids: string[], transaction?: Transaction): Promise<Map<string, Segment>> {
  const segments = await Segment.findAll({ where: { id: { [Op.in]: ids }, isActive: true }, transaction });
  const byId = new Map(segments.map((segment) => [segment.id, segment]));
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
