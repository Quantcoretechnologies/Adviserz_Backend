import { Sequelize } from 'sequelize';
import { sequelize } from '../../db/sequelize.js';
import { AppError } from '../../common/errors/AppError.js';
import { ErrorCode } from '../../common/errors/errorCodes.js';
import type { RequestContext } from '../../common/http/requestContext.js';
import { Segment } from '../../models/index.js';
import type { RiskBasis, SuggestedRiskMode } from '../../models/enums.js';
import { recordAudit } from '../audit/audit.service.js';
import { AuditAction } from '../audit/auditActions.js';
import { loadCurrentRules } from '../riskRules/riskRules.domain.js';
import { serializeSegment } from '../segments/segment.service.js';
import { createRuleSet, normaliseBands } from './adminRiskRules.service.js';

/**
 * Segments themselves (name, description, on/off, order). Capital and risk
 * limits are versioned capital bands, managed through adminRiskRules.service
 * (PUT /admin/segments/:id/risk-rules).
 */

export async function listAllSegments() {
  const segments = await Segment.findAll({ order: [['displayOrder', 'ASC'], ['name', 'ASC']] });
  const rules = await loadCurrentRules(segments.map((segment) => segment.id));
  return segments.map((segment) => serializeSegment(segment, rules.get(segment.id) ?? null));
}

async function serializeWithRules(segment: Segment) {
  const rules = await loadCurrentRules([segment.id]);
  return serializeSegment(segment, rules.get(segment.id) ?? null);
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

/**
 * Create a segment with its first version of risk limits: one band from
 * `minCapital`. More bands are added by saving the band table. Nobody holds a
 * new segment yet, so this first version notifies no one.
 */
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
    suggestedMode: SuggestedRiskMode;
    suggestedRiskPercent?: string | undefined;
    currency: string;
    isActive: boolean;
    displayOrder: number;
  },
  context: RequestContext,
) {
  await assertUnique(input.code, input.name);
  const bands = normaliseBands(input.suggestedMode, [
    {
      capitalFrom: input.minCapital,
      minRiskPercent: input.minRiskPercent,
      maxRiskPercent: input.maxRiskPercent,
      // Manual mode without a suggested value: suggested = maximum (no caution zone).
      suggestedRiskPercent:
        input.suggestedMode === 'manual' ? (input.suggestedRiskPercent ?? input.maxRiskPercent) : input.suggestedRiskPercent,
    },
  ]);

  const segment = await sequelize.transaction(async (transaction) => {
    const created = await Segment.create(
      {
        code: input.code,
        name: input.name,
        description: input.description ?? null,
        riskBasis: input.riskBasis,
        suggestedMode: input.suggestedMode,
        currency: input.currency,
        isActive: input.isActive,
        displayOrder: input.displayOrder,
        createdByAdminId: adminId,
        updatedByAdminId: adminId,
      },
      { transaction },
    );
    const rules = await createRuleSet(
      {
        segment: created,
        version: 1,
        mode: input.suggestedMode,
        bands,
        source: 'admin',
        notifyUsers: false,
        adminId,
        changeSummary: null,
      },
      transaction,
    );
    await recordAudit(
      {
        actor: { type: 'admin', id: adminId },
        action: AuditAction.ADMIN_SEGMENT_CREATED,
        entityType: 'segment',
        entityId: created.id,
        after: serializeSegment(created, rules),
        context,
      },
      transaction,
    );
    return created;
  });

  return serializeWithRules(segment);
}

export async function updateSegment(
  adminId: string,
  segmentId: string,
  input: {
    name?: string | undefined;
    description?: string | null | undefined;
    isActive?: boolean | undefined;
    displayOrder?: number | undefined;
  },
  context: RequestContext,
) {
  if (input.name) await assertUnique(null, input.name, segmentId);

  const segment = await sequelize.transaction(async (transaction) => {
    const target = await Segment.findByPk(segmentId, { lock: transaction.LOCK.UPDATE, transaction });
    if (!target) throw AppError.notFound('Segment not found');
    const before = serializeSegment(target, null);

    if (input.name !== undefined) target.name = input.name;
    if (input.description !== undefined) target.description = input.description;
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
        after: serializeSegment(target, null),
        context,
      },
      transaction,
    );
    return target;
  });

  return serializeWithRules(segment);
}
