import { Sequelize } from 'sequelize';
import { sequelize } from '../../db/sequelize.js';
import { AppError } from '../../common/errors/AppError.js';
import { ErrorCode } from '../../common/errors/errorCodes.js';
import type { RequestContext } from '../../common/http/requestContext.js';
import { formatMoney, formatPercent, toDecimal } from '../../common/utils/decimal.js';
import { Segment } from '../../models/index.js';
import type { RiskBasis } from '../../models/enums.js';
import { recordAudit } from '../audit/audit.service.js';
import { AuditAction } from '../audit/auditActions.js';
import { serializeSegment } from '../segments/segment.service.js';

export async function listAllSegments() {
  const segments = await Segment.findAll({ order: [['displayOrder', 'ASC'], ['name', 'ASC']] });
  return segments.map(serializeSegment);
}

async function assertUnique(code: string | null, name: string | null, excludeId?: string): Promise<void> {
  if (code) {
    const existing = await Segment.findOne({ where: { code }, attributes: ['id'] });
    if (existing && existing.id !== excludeId) {
      throw AppError.conflict('A segment with this code already exists', ErrorCode.CONFLICT, [
        { path: 'code', message: 'Code already in use' },
      ]);
    }
  }
  if (name) {
    const existing = await Segment.findOne({
      where: Sequelize.where(Sequelize.fn('LOWER', Sequelize.col('name')), name.toLowerCase()),
      attributes: ['id'],
    });
    if (existing && existing.id !== excludeId) {
      throw AppError.conflict('A segment with this name already exists', ErrorCode.CONFLICT, [
        { path: 'name', message: 'Name already in use' },
      ]);
    }
  }
}

export async function createSegment(
  adminId: string,
  input: {
    code: string;
    name: string;
    description?: string | null | undefined;
    riskBasis: RiskBasis;
    minCapital: string;
    minRiskPercent: string;
    maxRiskPercent: string;
    currency: string;
    isActive: boolean;
    displayOrder: number;
  },
  context: RequestContext,
) {
  await assertUnique(input.code, input.name);

  const segment = await sequelize.transaction(async (transaction) => {
    const created = await Segment.create(
      {
        code: input.code,
        name: input.name,
        description: input.description ?? null,
        riskBasis: input.riskBasis,
        minCapital: formatMoney(input.minCapital),
        minRiskPercent: formatPercent(input.minRiskPercent),
        maxRiskPercent: formatPercent(input.maxRiskPercent),
        currency: input.currency,
        isActive: input.isActive,
        displayOrder: input.displayOrder,
        createdByAdminId: adminId,
        updatedByAdminId: adminId,
      },
      { transaction },
    );
    await recordAudit(
      {
        actor: { type: 'admin', id: adminId },
        action: AuditAction.ADMIN_SEGMENT_CREATED,
        entityType: 'segment',
        entityId: created.id,
        after: serializeSegment(created),
        context,
      },
      transaction,
    );
    return created;
  });

  return serializeSegment(segment);
}

export async function updateSegment(
  adminId: string,
  segmentId: string,
  input: {
    name?: string | undefined;
    description?: string | null | undefined;
    minCapital?: string | undefined;
    minRiskPercent?: string | undefined;
    maxRiskPercent?: string | undefined;
    isActive?: boolean | undefined;
    displayOrder?: number | undefined;
  },
  context: RequestContext,
) {
  if (input.name) await assertUnique(null, input.name, segmentId);

  const segment = await sequelize.transaction(async (transaction) => {
    const target = await Segment.findByPk(segmentId, { lock: transaction.LOCK.UPDATE, transaction });
    if (!target) throw AppError.notFound('Segment not found');
    const before = serializeSegment(target);

    const minRisk = input.minRiskPercent ?? target.minRiskPercent;
    const maxRisk = input.maxRiskPercent ?? target.maxRiskPercent;
    if (toDecimal(minRisk).gt(maxRisk)) {
      throw AppError.unprocessable('Minimum risk percentage cannot exceed the maximum', ErrorCode.VALIDATION_ERROR, [
        { path: 'minRiskPercent', message: 'Minimum risk percentage cannot exceed the maximum' },
      ]);
    }

    if (input.name !== undefined) target.name = input.name;
    if (input.description !== undefined) target.description = input.description;
    if (input.minCapital !== undefined) target.minCapital = formatMoney(input.minCapital);
    if (input.minRiskPercent !== undefined) target.minRiskPercent = formatPercent(input.minRiskPercent);
    if (input.maxRiskPercent !== undefined) target.maxRiskPercent = formatPercent(input.maxRiskPercent);
    if (input.isActive !== undefined) target.isActive = input.isActive;
    if (input.displayOrder !== undefined) target.displayOrder = input.displayOrder;
    target.updatedByAdminId = adminId;
    await target.save({ transaction });

    await recordAudit(
      {
        actor: { type: 'admin', id: adminId },
        action: AuditAction.ADMIN_SEGMENT_UPDATED,
        entityType: 'segment',
        entityId: target.id,
        before,
        after: serializeSegment(target),
        context,
      },
      transaction,
    );
    return target;
  });

  return serializeSegment(segment);
}
