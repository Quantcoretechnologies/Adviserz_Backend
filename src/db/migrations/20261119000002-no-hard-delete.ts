import type { MigrationContext } from '../umzug.js';
import { executeInTransaction } from '../migrationUtils.js';

/**
 * Business data is never hard-deleted.
 *
 * risk_profile_segments
 *   - Removing a segment during onboarding used to delete its row, losing the
 *     capital and risk the user had entered. The row is now marked deleted
 *     (`is_deleted`, `deleted_at`) and kept. Every reader filters on
 *     `is_deleted = FALSE`. The unique index covers live rows only, so a
 *     segment can be selected again (it starts with a fresh row).
 *
 * Foreign keys
 *   - Links that used to CASCADE (delete the child rows with the parent) or
 *     SET NULL (forget who did something) now RESTRICT: the database refuses
 *     to delete a user, admin, risk profile or broker connection while rows
 *     still point at it. No code deletes those rows; this makes an accidental
 *     delete (bad query, script, future bug) fail instead of silently wiping
 *     history such as policy acceptances.
 *   - Kept as they are: refresh_tokens -> auth_sessions (CASCADE) and
 *     refresh_tokens -> refresh_tokens (SET NULL). The expired-session purge
 *     relies on them; sessions and tokens are short-lived security data, not
 *     business records, and every login/logout stays in audit_logs.
 */

interface ForeignKey {
  table: string;
  column: string;
  references: string;
  /** What the link did before this migration (restored by `down`). */
  previous: 'CASCADE' | 'SET NULL';
}

const FOREIGN_KEYS: readonly ForeignKey[] = [
  { table: 'auth_sessions', column: 'user_id', references: 'users', previous: 'CASCADE' },
  { table: 'auth_sessions', column: 'admin_id', references: 'admins', previous: 'CASCADE' },
  { table: 'verification_requests', column: 'user_id', references: 'users', previous: 'CASCADE' },
  { table: 'risk_profiles', column: 'user_id', references: 'users', previous: 'CASCADE' },
  { table: 'risk_profile_segments', column: 'risk_profile_id', references: 'risk_profiles', previous: 'CASCADE' },
  { table: 'policy_acceptances', column: 'user_id', references: 'users', previous: 'CASCADE' },
  { table: 'broker_connections', column: 'user_id', references: 'users', previous: 'CASCADE' },
  {
    table: 'broker_fund_snapshots',
    column: 'broker_connection_id',
    references: 'broker_connections',
    previous: 'CASCADE',
  },
  { table: 'users', column: 'blocked_by_admin_id', references: 'admins', previous: 'SET NULL' },
  { table: 'segments', column: 'created_by_admin_id', references: 'admins', previous: 'SET NULL' },
  { table: 'segments', column: 'updated_by_admin_id', references: 'admins', previous: 'SET NULL' },
  { table: 'policy_documents', column: 'created_by_admin_id', references: 'admins', previous: 'SET NULL' },
  { table: 'policy_documents', column: 'published_by_admin_id', references: 'admins', previous: 'SET NULL' },
];

function relink(key: ForeignKey, onDelete: string): string {
  const name = `${key.table}_${key.column}_fkey`;
  return `ALTER TABLE ${key.table}
       DROP CONSTRAINT ${name},
       ADD CONSTRAINT ${name} FOREIGN KEY (${key.column})
         REFERENCES ${key.references} (id) ON UPDATE CASCADE ON DELETE ${onDelete}`;
}

export async function up({ context: { sequelize } }: { context: MigrationContext }): Promise<void> {
  await executeInTransaction(sequelize, [
    `ALTER TABLE risk_profile_segments
       ADD COLUMN is_deleted BOOLEAN     NOT NULL DEFAULT FALSE,
       ADD COLUMN deleted_at TIMESTAMPTZ NULL,
       ADD CONSTRAINT risk_profile_segments_deleted_consistency_check CHECK (is_deleted = (deleted_at IS NOT NULL))`,
    `DROP INDEX risk_profile_segments_profile_segment_unique`,
    `CREATE UNIQUE INDEX risk_profile_segments_profile_segment_unique
       ON risk_profile_segments (risk_profile_id, segment_id) WHERE is_deleted = FALSE`,
    ...FOREIGN_KEYS.map((key) => relink(key, 'RESTRICT')),
  ]);
}

/**
 * Reverting is only possible while no segment row is marked deleted: dropping
 * the flag would bring such rows back as live selections. The migration then
 * refuses and rolls back, leaving the schema untouched.
 */
export async function down({ context: { sequelize } }: { context: MigrationContext }): Promise<void> {
  await executeInTransaction(sequelize, [
    `DO $$
     BEGIN
       IF EXISTS (SELECT 1 FROM risk_profile_segments WHERE is_deleted) THEN
         RAISE EXCEPTION 'Cannot revert: deleted risk profile segments exist';
       END IF;
     END
     $$`,
    ...FOREIGN_KEYS.map((key) => relink(key, key.previous)),
    `DROP INDEX risk_profile_segments_profile_segment_unique`,
    `CREATE UNIQUE INDEX risk_profile_segments_profile_segment_unique
       ON risk_profile_segments (risk_profile_id, segment_id)`,
    `ALTER TABLE risk_profile_segments
       DROP CONSTRAINT risk_profile_segments_deleted_consistency_check,
       DROP COLUMN deleted_at,
       DROP COLUMN is_deleted`,
  ]);
}
