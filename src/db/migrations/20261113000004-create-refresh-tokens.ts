import type { MigrationContext } from '../umzug.js';
import { executeInTransaction } from '../migrationUtils.js';

/**
 * Refresh tokens are opaque 256-bit random values; only their SHA-256 hash is
 * stored. Each session (the token family) has at most one live token — the
 * partial unique index guarantees it. A token is rotated on every refresh;
 * presenting an already-rotated token is reuse and revokes that session.
 */
export async function up({ context: { sequelize } }: { context: MigrationContext }): Promise<void> {
  await executeInTransaction(sequelize, [
    `CREATE TABLE refresh_tokens (
      id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      session_id      UUID        NOT NULL REFERENCES auth_sessions (id) ON UPDATE CASCADE ON DELETE CASCADE,
      token_hash      CHAR(64)    NOT NULL,
      expires_at      TIMESTAMPTZ NOT NULL,
      rotated_at      TIMESTAMPTZ NULL,
      replaced_by_id  UUID        NULL REFERENCES refresh_tokens (id) ON UPDATE CASCADE ON DELETE SET NULL,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT refresh_tokens_token_hash_format_check CHECK (token_hash ~ '^[0-9a-f]{64}$'),
      CONSTRAINT refresh_tokens_replacement_consistency_check CHECK (replaced_by_id IS NULL OR rotated_at IS NOT NULL)
    )`,
    `CREATE UNIQUE INDEX refresh_tokens_token_hash_unique ON refresh_tokens (token_hash)`,
    `CREATE INDEX refresh_tokens_session_id_idx ON refresh_tokens (session_id)`,
    `CREATE UNIQUE INDEX refresh_tokens_one_live_per_session_unique ON refresh_tokens (session_id) WHERE rotated_at IS NULL`,
    `CREATE INDEX refresh_tokens_replaced_by_id_idx ON refresh_tokens (replaced_by_id) WHERE replaced_by_id IS NOT NULL`,
    `COMMENT ON TABLE refresh_tokens IS 'Hashed opaque refresh tokens; rotated on every use'`,
  ]);
}

export async function down({ context: { sequelize } }: { context: MigrationContext }): Promise<void> {
  await executeInTransaction(sequelize, [`DROP TABLE IF EXISTS refresh_tokens`]);
}
