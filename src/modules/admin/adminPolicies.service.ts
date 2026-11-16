import { sequelize } from '../../db/sequelize.js';
import { AppError } from '../../common/errors/AppError.js';
import { ErrorCode } from '../../common/errors/errorCodes.js';
import type { RequestContext } from '../../common/http/requestContext.js';
import { sha256Hex } from '../../common/utils/crypto.js';
import { PolicyDocument } from '../../models/index.js';
import type { PolicyStatus, PolicyType } from '../../models/enums.js';
import { recordAudit } from '../audit/audit.service.js';
import { AuditAction } from '../audit/auditActions.js';
import { serializePolicy } from '../policies/policy.service.js';

/**
 * Policy lifecycle: create draft -> edit draft -> publish. Publishing makes
 * the version immutable and current; every user is then asked to re-accept
 * (see policy.service#getPendingPolicies).
 */

export async function listPolicies(filter: { type?: PolicyType | undefined; status?: PolicyStatus | undefined }) {
  const docs = await PolicyDocument.findAll({
    where: { ...(filter.type ? { type: filter.type } : {}), ...(filter.status ? { status: filter.status } : {}) },
    order: [['type', 'ASC'], ['version', 'DESC']],
  });
  return docs.map((doc) => serializePolicy(doc, { includeContent: false }));
}

export async function getPolicy(id: string) {
  const doc = await PolicyDocument.findByPk(id);
  if (!doc) throw AppError.notFound('Policy not found');
  return serializePolicy(doc, { includeContent: true });
}

export async function createPolicyDraft(
  adminId: string,
  input: { type: PolicyType; title: string; content: string },
  context: RequestContext,
) {
  const doc = await sequelize.transaction(async (transaction) => {
    // Serialise draft creation per type so versions never collide.
    await sequelize.query('SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))', {
      replacements: { key: `policy:${input.type}` },
      transaction,
    });

    const existingDraft = await PolicyDocument.findOne({ where: { type: input.type, status: 'draft' }, transaction });
    if (existingDraft) {
      throw AppError.conflict('A draft already exists for this policy. Edit or publish it first', ErrorCode.CONFLICT, [
        { path: 'type', message: 'Draft already exists', policyDocumentId: existingDraft.id },
      ]);
    }

    const maxVersion = (await PolicyDocument.max<number | null, PolicyDocument>('version', {
      where: { type: input.type },
      transaction,
    })) as number | null;

    const created = await PolicyDocument.create(
      {
        type: input.type,
        version: (maxVersion ?? 0) + 1,
        title: input.title,
        content: input.content,
        contentSha256: sha256Hex(input.content),
        status: 'draft',
        createdByAdminId: adminId,
      },
      { transaction },
    );

    await recordAudit(
      {
        actor: { type: 'admin', id: adminId },
        action: AuditAction.ADMIN_POLICY_DRAFT_CREATED,
        entityType: 'policy_document',
        entityId: created.id,
        after: serializePolicy(created, { includeContent: false }),
        context,
      },
      transaction,
    );
    return created;
  });

  return serializePolicy(doc, { includeContent: true });
}

export async function updatePolicyDraft(
  adminId: string,
  id: string,
  input: { title?: string | undefined; content?: string | undefined },
  context: RequestContext,
) {
  const doc = await sequelize.transaction(async (transaction) => {
    const target = await PolicyDocument.findByPk(id, { lock: transaction.LOCK.UPDATE, transaction });
    if (!target) throw AppError.notFound('Policy not found');
    if (target.status !== 'draft') {
      throw AppError.conflict('Published policies cannot be edited. Create a new version instead', ErrorCode.POLICY_NOT_EDITABLE);
    }

    const before = serializePolicy(target, { includeContent: false });
    if (input.title !== undefined) target.title = input.title;
    if (input.content !== undefined) {
      target.content = input.content;
      target.contentSha256 = sha256Hex(input.content);
    }
    await target.save({ transaction });

    await recordAudit(
      {
        actor: { type: 'admin', id: adminId },
        action: AuditAction.ADMIN_POLICY_DRAFT_UPDATED,
        entityType: 'policy_document',
        entityId: target.id,
        before,
        after: serializePolicy(target, { includeContent: false }),
        context,
      },
      transaction,
    );
    return target;
  });

  return serializePolicy(doc, { includeContent: true });
}

export async function publishPolicy(adminId: string, id: string, context: RequestContext) {
  const doc = await sequelize.transaction(async (transaction) => {
    const target = await PolicyDocument.findByPk(id, { lock: transaction.LOCK.UPDATE, transaction });
    if (!target) throw AppError.notFound('Policy not found');
    if (target.status !== 'draft') {
      throw AppError.conflict('This policy version is already published', ErrorCode.POLICY_NOT_EDITABLE);
    }

    target.status = 'published';
    target.publishedAt = new Date();
    target.publishedByAdminId = adminId;
    await target.save({ transaction });

    await recordAudit(
      {
        actor: { type: 'admin', id: adminId },
        action: AuditAction.ADMIN_POLICY_PUBLISHED,
        entityType: 'policy_document',
        entityId: target.id,
        severity: 'warning',
        after: serializePolicy(target, { includeContent: false }),
        context,
      },
      transaction,
    );
    return target;
  });

  return serializePolicy(doc, { includeContent: true });
}
