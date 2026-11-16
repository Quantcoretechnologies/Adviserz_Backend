import type { MigrationContext } from '../umzug.js';
import { executeInTransaction } from '../migrationUtils.js';

/**
 * Platform administrators. Kept separate from `users` so customer accounts can
 * never be escalated into admin access by a role flag.
 */
export async function up({ context: { sequelize } }: { context: MigrationContext }): Promise<void> {
  await executeInTransaction(sequelize, [
    `CREATE TABLE admins (
      id                     UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
      full_name              VARCHAR(100) NOT NULL,
      email                  VARCHAR(254) NOT NULL,
      password_hash          VARCHAR(255) NOT NULL,
      role                   VARCHAR(30)  NOT NULL DEFAULT 'super_admin',
      status                 VARCHAR(20)  NOT NULL DEFAULT 'active',
      failed_login_attempts  INTEGER      NOT NULL DEFAULT 0,
      locked_until           TIMESTAMPTZ  NULL,
      last_login_at          TIMESTAMPTZ  NULL,
      password_changed_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      created_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      updated_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      CONSTRAINT admins_role_check CHECK (role IN ('super_admin')),
      CONSTRAINT admins_status_check CHECK (status IN ('active', 'disabled')),
      CONSTRAINT admins_email_lowercase_check CHECK (email = LOWER(email)),
      CONSTRAINT admins_failed_login_attempts_check CHECK (failed_login_attempts >= 0)
    )`,
    `CREATE UNIQUE INDEX admins_email_unique ON admins (email)`,
    `COMMENT ON TABLE admins IS 'Platform administrators (separate from customer users)'`,
  ]);
}

export async function down({ context: { sequelize } }: { context: MigrationContext }): Promise<void> {
  await executeInTransaction(sequelize, [`DROP TABLE IF EXISTS admins`]);
}
