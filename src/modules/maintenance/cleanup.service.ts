import { QueryTypes, type Transaction } from 'sequelize';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { sequelize } from '../../db/sequelize.js';
import { recordAudit } from '../audit/audit.service.js';
import { AuditAction } from '../audit/auditActions.js';

/**
 * Purge of authentication data that has outlived its purpose:
 *
 * - auth_sessions that ended (expired or revoked) more than the retention
 *   period ago; their refresh_tokens are removed by ON DELETE CASCADE.
 * - verification_requests created more than the retention period ago. OTPs
 *   and verification tokens expire within an hour, so these are long dead.
 *
 * What is NOT touched: live sessions, users, risk profiles, policy
 * acceptances and audit_logs (the permanent record of every login, OTP and
 * revocation).
 *
 * Deletes run in bounded batches so a large backlog never holds long locks;
 * whatever remains is picked up by the next run.
 */

const BATCH_SIZE = 5_000;
const MAX_BATCHES_PER_RUN = 20;
/** Arbitrary constant identifying this job's advisory lock. */
const CLEANUP_LOCK_KEY = 'maintenance:auth-data-cleanup';

export interface CleanupResult {
  skipped: boolean;
  sessionsDeleted: number;
  verificationRequestsDeleted: number;
  cutoff: Date;
}

async function deleteInBatches(sql: string, cutoff: Date, transaction: Transaction): Promise<number> {
  let total = 0;
  for (let batch = 0; batch < MAX_BATCHES_PER_RUN; batch += 1) {
    const rows = await sequelize.query<{ id: string }>(sql, {
      type: QueryTypes.SELECT,
      replacements: { cutoff, limit: BATCH_SIZE },
      transaction,
    });
    total += rows.length;
    if (rows.length < BATCH_SIZE) break;
  }
  return total;
}

/**
 * Run one purge. Safe to call from several instances at once: a
 * transaction-scoped advisory lock lets exactly one proceed; the others
 * return `skipped: true`.
 */
export async function purgeExpiredAuthData(now: Date = new Date()): Promise<CleanupResult> {
  const cutoff = new Date(now.getTime() - env.AUTH_DATA_RETENTION_DAYS * 24 * 60 * 60 * 1000);

  return sequelize.transaction(async (transaction): Promise<CleanupResult> => {
    const [lock] = await sequelize.query<{ acquired: boolean }>(
      'SELECT pg_try_advisory_xact_lock(hashtextextended(:key, 0)) AS acquired',
      { type: QueryTypes.SELECT, replacements: { key: CLEANUP_LOCK_KEY }, transaction },
    );
    if (!lock?.acquired) {
      return { skipped: true, sessionsDeleted: 0, verificationRequestsDeleted: 0, cutoff };
    }

    const sessionsDeleted = await deleteInBatches(
      `DELETE FROM auth_sessions
        WHERE id IN (
          SELECT id FROM auth_sessions
           WHERE expires_at < :cutoff OR revoked_at < :cutoff
           LIMIT :limit)
        RETURNING id`,
      cutoff,
      transaction,
    );

    const verificationRequestsDeleted = await deleteInBatches(
      `DELETE FROM verification_requests
        WHERE id IN (
          SELECT id FROM verification_requests
           WHERE created_at < :cutoff
           LIMIT :limit)
        RETURNING id`,
      cutoff,
      transaction,
    );

    if (sessionsDeleted > 0 || verificationRequestsDeleted > 0) {
      await recordAudit(
        {
          actor: { type: 'system' },
          action: AuditAction.EXPIRED_AUTH_DATA_PURGED,
          metadata: {
            sessionsDeleted,
            verificationRequestsDeleted,
            cutoff: cutoff.toISOString(),
            retentionDays: env.AUTH_DATA_RETENTION_DAYS,
          },
        },
        transaction,
      );
    }

    return { skipped: false, sessionsDeleted, verificationRequestsDeleted, cutoff };
  });
}

/**
 * Start the periodic in-process purge. Returns a stop function for graceful
 * shutdown. Runs never overlap within a process, and the advisory lock keeps
 * instances from duplicating work. Failures are logged and retried next tick.
 */
export function startCleanupScheduler(): () => void {
  if (env.CLEANUP_INTERVAL_MINUTES === 0) {
    logger.info('In-process cleanup disabled (CLEANUP_INTERVAL_MINUTES=0)');
    return () => undefined;
  }

  let running = false;
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const result = await purgeExpiredAuthData();
      if (!result.skipped && (result.sessionsDeleted > 0 || result.verificationRequestsDeleted > 0)) {
        logger.info(result, 'Expired auth data purged');
      }
    } catch (error) {
      logger.error({ err: error }, 'Expired auth data purge failed');
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), env.CLEANUP_INTERVAL_MINUTES * 60 * 1000);
  timer.unref();
  return () => clearInterval(timer);
}
