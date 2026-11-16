import type { MigrationContext } from '../umzug.js';
import { executeInTransaction } from '../migrationUtils.js';

/**
 * Point-in-time fund balances fetched from a broker. Used for the capital
 * check: comparing declared capital against funds actually available.
 * Append-only; each sync inserts a new snapshot.
 */
export async function up({ context: { sequelize } }: { context: MigrationContext }): Promise<void> {
  await executeInTransaction(sequelize, [
    `CREATE TABLE broker_fund_snapshots (
      id                    UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
      broker_connection_id  UUID          NOT NULL REFERENCES broker_connections (id) ON UPDATE CASCADE ON DELETE CASCADE,
      available_margin      NUMERIC(18,2) NOT NULL,
      used_margin           NUMERIC(18,2) NOT NULL DEFAULT 0,
      total_balance         NUMERIC(18,2) NOT NULL,
      currency              CHAR(3)       NOT NULL DEFAULT 'INR',
      captured_at           TIMESTAMPTZ   NOT NULL,
      created_at            TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
      CONSTRAINT broker_fund_snapshots_currency_format_check CHECK (currency ~ '^[A-Z]{3}$'),
      CONSTRAINT broker_fund_snapshots_used_margin_check CHECK (used_margin >= 0)
    )`,
    `CREATE INDEX broker_fund_snapshots_connection_captured_idx
       ON broker_fund_snapshots (broker_connection_id, captured_at DESC)`,
    `COMMENT ON TABLE broker_fund_snapshots IS 'Broker fund balances captured for capital verification'`,
  ]);
}

export async function down({ context: { sequelize } }: { context: MigrationContext }): Promise<void> {
  await executeInTransaction(sequelize, [`DROP TABLE IF EXISTS broker_fund_snapshots`]);
}
