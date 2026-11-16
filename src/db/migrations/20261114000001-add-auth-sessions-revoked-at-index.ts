import type { MigrationContext } from '../umzug.js';
import { executeInTransaction } from '../migrationUtils.js';

/**
 * Supports the scheduled purge of ended sessions, which deletes rows by
 * `expires_at` (already indexed) OR `revoked_at`. Partial: live sessions
 * (revoked_at IS NULL) are the majority and never match.
 */
export async function up({ context: { sequelize } }: { context: MigrationContext }): Promise<void> {
  await executeInTransaction(sequelize, [
    `CREATE INDEX auth_sessions_revoked_at_idx ON auth_sessions (revoked_at) WHERE revoked_at IS NOT NULL`,
  ]);
}

export async function down({ context: { sequelize } }: { context: MigrationContext }): Promise<void> {
  await executeInTransaction(sequelize, [`DROP INDEX IF EXISTS auth_sessions_revoked_at_idx`]);
}
