import { Op, type Transaction } from 'sequelize';
import { AppError } from '../../common/errors/AppError.js';
import { ErrorCode } from '../../common/errors/errorCodes.js';
import type { RequestContext } from '../../common/http/requestContext.js';
import { PolicyAcceptance, PolicyDocument } from '../../models/index.js';
import { CONSENT_POLICY_TYPES } from '../../models/enums.js';
import { recordAudit } from '../audit/audit.service.js';
import { AuditAction } from '../audit/auditActions.js';

export function serializePolicy(doc: PolicyDocument, options: { includeContent: boolean }) {
  return {
    id: doc.id,
    type: doc.type,
    version: doc.version,
    title: doc.title,
    status: doc.status,
    publishedAt: doc.publishedAt,
    contentSha256: doc.contentSha256,
    ...(options.includeContent ? { content: doc.content } : {}),
  };
}

/**
 * The current version of each CONSENT policy (Terms, Risk Policy): the highest
 * published version. Types with nothing published yet are omitted (nothing to
 * accept). Disclaimer texts are not consent policies: they are accepted at the
 * moment they apply (see modules/riskRules), never through this list.
 */
export async function getCurrentPolicies(transaction?: Transaction): Promise<PolicyDocument[]> {
  const docs = await Promise.all(
    CONSENT_POLICY_TYPES.map((type) =>
      PolicyDocument.findOne({
        where: { type, status: 'published' },
        order: [['version', 'DESC']],
        transaction,
      }),
    ),
  );
  return docs.filter((doc): doc is PolicyDocument => doc !== null);
}

/** Current policies the user has not accepted yet. */
export async function getPendingPolicies(userId: string, transaction?: Transaction): Promise<PolicyDocument[]> {
  const current = await getCurrentPolicies(transaction);
  if (current.length === 0) return [];

  const accepted = await PolicyAcceptance.findAll({
    where: { userId, policyDocumentId: { [Op.in]: current.map((doc) => doc.id) } },
    attributes: ['policyDocumentId'],
    transaction,
  });
  const acceptedIds = new Set(accepted.map((row) => row.policyDocumentId));
  return current.filter((doc) => !acceptedIds.has(doc.id));
}

/**
 * Record acceptance of the given policy documents. Every id must be the
 * CURRENT version of its type — accepting an outdated or draft version is
 * rejected, so a stale client cannot record consent to text that is no longer
 * in force. Already-accepted ids are ignored (idempotent).
 */
export async function acceptPolicies(
  params: { userId: string; policyDocumentIds: string[]; context: RequestContext },
  transaction: Transaction,
): Promise<PolicyDocument[]> {
  const current = await getCurrentPolicies(transaction);
  const currentById = new Map(current.map((doc) => [doc.id, doc]));

  const outdated = params.policyDocumentIds.filter((id) => !currentById.has(id));
  if (outdated.length > 0) {
    throw AppError.conflict(
      'One or more policies are not the current version. Please review the latest policies',
      ErrorCode.POLICY_VERSION_OUTDATED,
      outdated.map((id) => ({ path: 'policyDocumentIds', message: 'Not a current policy version', id })),
    );
  }

  const existing = await PolicyAcceptance.findAll({
    where: { userId: params.userId, policyDocumentId: { [Op.in]: params.policyDocumentIds } },
    attributes: ['policyDocumentId'],
    transaction,
  });
  const alreadyAccepted = new Set(existing.map((row) => row.policyDocumentId));
  const toAccept = params.policyDocumentIds.filter((id) => !alreadyAccepted.has(id));

  if (toAccept.length > 0) {
    const now = new Date();
    await PolicyAcceptance.bulkCreate(
      toAccept.map((policyDocumentId) => ({
        userId: params.userId,
        policyDocumentId,
        acceptedAt: now,
        ipAddress: params.context.ipAddress,
        userAgent: params.context.userAgent,
      })),
      { transaction },
    );

    await recordAudit(
      {
        actor: { type: 'user', id: params.userId },
        action: AuditAction.POLICIES_ACCEPTED,
        entityType: 'policy_document',
        subjectUserId: params.userId,
        after: {
          policies: toAccept.map((id) => {
            const doc = currentById.get(id);
            return { id, type: doc?.type, version: doc?.version, contentSha256: doc?.contentSha256 };
          }),
        },
        context: params.context,
      },
      transaction,
    );
  }

  return toAccept.map((id) => currentById.get(id)).filter((doc): doc is PolicyDocument => doc !== undefined);
}

/**
 * Throw POLICY_ACCEPTANCE_REQUIRED when the user still owes acceptance of a
 * current policy. Used by onboarding confirmation and the post-onboarding
 * route guard.
 */
export async function assertPoliciesAccepted(userId: string, transaction?: Transaction): Promise<void> {
  const pending = await getPendingPolicies(userId, transaction);
  if (pending.length > 0) {
    throw new AppError(
      403,
      ErrorCode.POLICY_ACCEPTANCE_REQUIRED,
      'Please review and accept the latest policies to continue',
      pending.map((doc) => ({
        message: 'Acceptance required',
        policyDocumentId: doc.id,
        type: doc.type,
        version: doc.version,
      })),
    );
  }
}
