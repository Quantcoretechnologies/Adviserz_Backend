import type { MigrationContext } from '../umzug.js';
import { executeInTransaction } from '../migrationUtils.js';

/**
 * Customer accounts. Email and phone are verified BEFORE the row exists
 * (see verification_requests), so both *_verified_at columns are NOT NULL.
 *
 * Normalisation contract (enforced by CHECKs):
 *   - email is stored lower-cased
 *   - phone is stored as E.164 India mobile: +91 followed by 10 digits (6-9 first)
 *   - username uniqueness is case-insensitive
 */
export async function up({ context: { sequelize } }: { context: MigrationContext }): Promise<void> {
  await executeInTransaction(sequelize, [
    `CREATE TABLE users (
      id                       UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
      full_name                VARCHAR(100) NOT NULL,
      username                 VARCHAR(30)  NOT NULL,
      email                    VARCHAR(254) NOT NULL,
      phone                    VARCHAR(13)  NOT NULL,
      password_hash            VARCHAR(255) NOT NULL,
      email_verified_at        TIMESTAMPTZ  NOT NULL,
      phone_verified_at        TIMESTAMPTZ  NOT NULL,
      status                   VARCHAR(20)  NOT NULL DEFAULT 'active',
      blocked_at               TIMESTAMPTZ  NULL,
      blocked_reason           VARCHAR(500) NULL,
      blocked_by_admin_id      UUID         NULL REFERENCES admins (id) ON UPDATE CASCADE ON DELETE SET NULL,
      onboarding_status        VARCHAR(20)  NOT NULL DEFAULT 'pending',
      onboarding_completed_at  TIMESTAMPTZ  NULL,
      failed_login_attempts    INTEGER      NOT NULL DEFAULT 0,
      locked_until             TIMESTAMPTZ  NULL,
      last_login_at            TIMESTAMPTZ  NULL,
      password_changed_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      created_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      updated_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      CONSTRAINT users_status_check CHECK (status IN ('active', 'blocked')),
      CONSTRAINT users_blocked_consistency_check CHECK ((status = 'blocked') = (blocked_at IS NOT NULL)),
      CONSTRAINT users_onboarding_status_check CHECK (onboarding_status IN ('pending', 'completed')),
      CONSTRAINT users_onboarding_consistency_check
        CHECK ((onboarding_status = 'completed') = (onboarding_completed_at IS NOT NULL)),
      CONSTRAINT users_email_lowercase_check CHECK (email = LOWER(email)),
      CONSTRAINT users_phone_format_check CHECK (phone ~ '^[+]91[6-9][0-9]{9}$'),
      CONSTRAINT users_username_format_check CHECK (username ~ '^[A-Za-z][A-Za-z0-9._]{2,29}$'),
      CONSTRAINT users_failed_login_attempts_check CHECK (failed_login_attempts >= 0)
    )`,
    `CREATE UNIQUE INDEX users_username_lower_unique ON users (LOWER(username))`,
    `CREATE UNIQUE INDEX users_email_unique ON users (email)`,
    `CREATE UNIQUE INDEX users_phone_unique ON users (phone)`,
    `CREATE INDEX users_created_at_idx ON users (created_at)`,
    `CREATE INDEX users_status_onboarding_idx ON users (status, onboarding_status)`,
    `CREATE INDEX users_blocked_by_admin_id_idx ON users (blocked_by_admin_id) WHERE blocked_by_admin_id IS NOT NULL`,
    `COMMENT ON TABLE users IS 'Customer accounts (web + mobile)'`,
  ]);
}

export async function down({ context: { sequelize } }: { context: MigrationContext }): Promise<void> {
  await executeInTransaction(sequelize, [`DROP TABLE IF EXISTS users`]);
}
