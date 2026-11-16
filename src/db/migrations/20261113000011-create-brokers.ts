import type { MigrationContext } from '../umzug.js';
import { executeInTransaction } from '../migrationUtils.js';

/**
 * Supported stock brokers (master list). Integrations are not live yet; rows
 * are seeded inactive and enabled once a broker adapter is implemented.
 */
export async function up({ context: { sequelize } }: { context: MigrationContext }): Promise<void> {
  await executeInTransaction(sequelize, [
    `CREATE TABLE brokers (
      id             UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
      code           VARCHAR(50)  NOT NULL,
      name           VARCHAR(100) NOT NULL,
      is_active      BOOLEAN      NOT NULL DEFAULT FALSE,
      display_order  INTEGER      NOT NULL DEFAULT 0,
      created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      updated_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      CONSTRAINT brokers_code_format_check CHECK (code ~ '^[A-Z][A-Z0-9_]{1,49}$')
    )`,
    `CREATE UNIQUE INDEX brokers_code_unique ON brokers (code)`,
    `COMMENT ON TABLE brokers IS 'Supported brokers for account connection'`,
  ]);
}

export async function down({ context: { sequelize } }: { context: MigrationContext }): Promise<void> {
  await executeInTransaction(sequelize, [`DROP TABLE IF EXISTS brokers`]);
}
