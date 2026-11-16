import type { Transaction } from 'sequelize';
import { logger } from '../../config/logger.js';
import type { RequestContext } from '../../common/http/requestContext.js';
import { AuditLog } from '../../models/index.js';
import type { AuditActorType, AuditOutcome, AuditSeverity } from '../../models/enums.js';
import type { AuditAction } from './auditActions.js';

export interface AuditActor {
  type: AuditActorType;
  id?: string | null;
}

export interface AuditEntry {
  actor: AuditActor;
  action: AuditAction;
  entityType?: string;
  entityId?: string | null;
  /** The customer whose data was touched; powers per-user audit views. */
  subjectUserId?: string | null;
  severity?: AuditSeverity;
  outcome?: AuditOutcome;
  /** Pass allow-listed fields only. Sensitive keys are redacted regardless. */
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
  context?: RequestContext | null;
}

/** Keys whose values are never persisted, matched case-insensitively. */
const SENSITIVE_KEY = /pass(word)?|secret|token|otp|hash|authorization|cookie|api[-_]?key/i;
const MAX_DEPTH = 5;

function redact(value: unknown, depth = 0): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return value.toISOString();
  if (depth >= MAX_DEPTH) return '[TRUNCATED]';
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  const output: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    output[key] = SENSITIVE_KEY.test(key) ? '[REDACTED]' : redact(inner, depth + 1);
  }
  return output;
}

function toRecord(value: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  return value ? (redact(value) as Record<string, unknown>) : null;
}

/**
 * Persist an audit entry. When `transaction` is given the entry commits or
 * rolls back together with the business change it describes — use this for
 * every successful state change. Throws on failure (the caller's transaction
 * then rolls back, so no change is ever left unaudited).
 */
export async function recordAudit(entry: AuditEntry, transaction?: Transaction): Promise<void> {
  await AuditLog.create(
    {
      actorType: entry.actor.type,
      actorId: entry.actor.id ?? null,
      action: entry.action,
      entityType: entry.entityType ?? null,
      entityId: entry.entityId ?? null,
      subjectUserId: entry.subjectUserId ?? null,
      severity: entry.severity ?? 'info',
      outcome: entry.outcome ?? 'success',
      beforeData: toRecord(entry.before),
      afterData: toRecord(entry.after),
      metadata: toRecord(entry.metadata),
      ipAddress: entry.context?.ipAddress ?? null,
      userAgent: entry.context?.userAgent ?? null,
      requestId: entry.context?.requestId ?? null,
    },
    { transaction },
  );
}

/**
 * Persist an audit entry outside any business transaction, for events whose
 * request ultimately fails (bad password, invalid OTP, token reuse). Never
 * throws: a broken audit write is logged at error level but must not mask the
 * original response.
 */
export async function recordAuditIndependently(entry: AuditEntry): Promise<void> {
  try {
    await recordAudit(entry);
  } catch (error) {
    logger.error({ err: error, action: entry.action }, 'Failed to write audit log entry');
  }
}
