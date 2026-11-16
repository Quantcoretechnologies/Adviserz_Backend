import type { MigrationContext } from '../umzug.js';
import { executeInTransaction } from '../migrationUtils.js';

/**
 * Evidence that a user accepted a specific policy version, with when and from
 * where. Rows are never updated; a user accepts each version exactly once.
 * Policy documents cannot be deleted while acceptances reference them.
 */
export async function up({ context: { sequelize } }: { context: MigrationContext }): Promise<void> {
  await executeInTransaction(sequelize, [
    `CREATE TABLE policy_acceptances (
      id                  UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id             UUID         NOT NULL REFERENCES users (id) ON UPDATE CASCADE ON DELETE CASCADE,
      policy_document_id  UUID         NOT NULL REFERENCES policy_documents (id) ON UPDATE CASCADE ON DELETE RESTRICT,
      accepted_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      ip_address          VARCHAR(45)  NULL,
      user_agent          VARCHAR(512) NULL,
      created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )`,
    `CREATE UNIQUE INDEX policy_acceptances_user_document_unique ON policy_acceptances (user_id, policy_document_id)`,
    `CREATE INDEX policy_acceptances_policy_document_id_idx ON policy_acceptances (policy_document_id)`,
    `COMMENT ON TABLE policy_acceptances IS 'Record of each policy version accepted by each user'`,
  ]);
}

export async function down({ context: { sequelize } }: { context: MigrationContext }): Promise<void> {
  await executeInTransaction(sequelize, [`DROP TABLE IF EXISTS policy_acceptances`]);
}
