import type { MigrationContext } from '../umzug.js';
import { executeInTransaction } from '../migrationUtils.js';

/**
 * A user's link to a broker account. Broker credentials are stored ONLY in
 * encrypted form (application-level envelope encryption); plaintext tokens
 * must never be written to this table.
 */
export async function up({ context: { sequelize } }: { context: MigrationContext }): Promise<void> {
  await executeInTransaction(sequelize, [
    `CREATE TABLE broker_connections (
      id                       UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id                  UUID         NOT NULL REFERENCES users (id) ON UPDATE CASCADE ON DELETE CASCADE,
      broker_id                UUID         NOT NULL REFERENCES brokers (id) ON UPDATE CASCADE ON DELETE RESTRICT,
      status                   VARCHAR(20)  NOT NULL DEFAULT 'pending',
      broker_client_id         VARCHAR(100) NULL,
      access_token_encrypted   TEXT         NULL,
      refresh_token_encrypted  TEXT         NULL,
      token_expires_at         TIMESTAMPTZ  NULL,
      connected_at             TIMESTAMPTZ  NULL,
      disconnected_at          TIMESTAMPTZ  NULL,
      last_synced_at           TIMESTAMPTZ  NULL,
      last_error               VARCHAR(500) NULL,
      created_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      updated_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      CONSTRAINT broker_connections_status_check
        CHECK (status IN ('pending', 'connected', 'expired', 'revoked', 'error')),
      CONSTRAINT broker_connections_connected_consistency_check
        CHECK (status <> 'connected' OR connected_at IS NOT NULL)
    )`,
    `CREATE UNIQUE INDEX broker_connections_user_broker_unique ON broker_connections (user_id, broker_id)`,
    `CREATE INDEX broker_connections_broker_id_idx ON broker_connections (broker_id)`,
    `COMMENT ON TABLE broker_connections IS 'User broker account links (credentials encrypted at rest)'`,
  ]);
}

export async function down({ context: { sequelize } }: { context: MigrationContext }): Promise<void> {
  await executeInTransaction(sequelize, [`DROP TABLE IF EXISTS broker_connections`]);
}
