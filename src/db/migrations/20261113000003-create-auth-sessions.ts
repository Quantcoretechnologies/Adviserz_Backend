import type { MigrationContext } from '../umzug.js';
import { executeInTransaction } from '../migrationUtils.js';

/**
 * One row per signed-in device. A session belongs to exactly one subject —
 * either a user or an admin — enforced by num_nonnulls(). Every access token
 * carries its session id, so revoking a session cuts off access immediately.
 */
export async function up({ context: { sequelize } }: { context: MigrationContext }): Promise<void> {
  await executeInTransaction(sequelize, [
    `CREATE TABLE auth_sessions (
      id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id         UUID         NULL REFERENCES users (id) ON UPDATE CASCADE ON DELETE CASCADE,
      admin_id        UUID         NULL REFERENCES admins (id) ON UPDATE CASCADE ON DELETE CASCADE,
      client_type     VARCHAR(10)  NOT NULL,
      device_name     VARCHAR(100) NULL,
      user_agent      VARCHAR(512) NULL,
      ip_address      VARCHAR(45)  NULL,
      last_used_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      expires_at      TIMESTAMPTZ  NOT NULL,
      revoked_at      TIMESTAMPTZ  NULL,
      revoked_reason  VARCHAR(50)  NULL,
      created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      CONSTRAINT auth_sessions_single_subject_check CHECK (num_nonnulls(user_id, admin_id) = 1),
      CONSTRAINT auth_sessions_client_type_check CHECK (client_type IN ('web', 'mobile')),
      CONSTRAINT auth_sessions_revocation_consistency_check CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL)),
      CONSTRAINT auth_sessions_expiry_check CHECK (expires_at > created_at)
    )`,
    `CREATE INDEX auth_sessions_user_id_idx ON auth_sessions (user_id) WHERE user_id IS NOT NULL`,
    `CREATE INDEX auth_sessions_admin_id_idx ON auth_sessions (admin_id) WHERE admin_id IS NOT NULL`,
    `CREATE INDEX auth_sessions_expires_at_idx ON auth_sessions (expires_at)`,
    `COMMENT ON TABLE auth_sessions IS 'Per-device sessions for users and admins; refresh-token family root'`,
  ]);
}

export async function down({ context: { sequelize } }: { context: MigrationContext }): Promise<void> {
  await executeInTransaction(sequelize, [`DROP TABLE IF EXISTS auth_sessions`]);
}
