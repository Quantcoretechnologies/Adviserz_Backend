import type { MigrationContext } from '../umzug.js';
import { executeInTransaction } from '../migrationUtils.js';

/**
 * Versioned risk profiles (onboarding answers). History is never overwritten:
 *
 *   draft      — onboarding in progress, filled step by step (at most one per user)
 *   active     — the profile currently in force (at most one per user)
 *   superseded — an earlier active profile replaced by a later edit
 *
 * Editing a confirmed profile inserts a new `active` version and marks the
 * previous one `superseded`, in one transaction.
 */
export async function up({ context: { sequelize } }: { context: MigrationContext }): Promise<void> {
  await executeInTransaction(sequelize, [
    `CREATE TABLE risk_profiles (
      id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id             UUID        NOT NULL REFERENCES users (id) ON UPDATE CASCADE ON DELETE CASCADE,
      version             INTEGER     NOT NULL,
      status              VARCHAR(20) NOT NULL,
      source              VARCHAR(20) NOT NULL,
      market_experience   VARCHAR(20) NULL,
      broker_step_status  VARCHAR(20) NULL,
      confirmed_at        TIMESTAMPTZ NULL,
      superseded_at       TIMESTAMPTZ NULL,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT risk_profiles_version_check CHECK (version >= 1),
      CONSTRAINT risk_profiles_status_check CHECK (status IN ('draft', 'active', 'superseded')),
      CONSTRAINT risk_profiles_source_check CHECK (source IN ('onboarding', 'profile_update')),
      CONSTRAINT risk_profiles_market_experience_check
        CHECK (market_experience IS NULL OR market_experience IN ('beginner', 'intermediate', 'experienced')),
      CONSTRAINT risk_profiles_broker_step_status_check
        CHECK (broker_step_status IS NULL OR broker_step_status IN ('skipped', 'connected')),
      CONSTRAINT risk_profiles_confirmed_consistency_check
        CHECK (status = 'draft' OR (market_experience IS NOT NULL AND confirmed_at IS NOT NULL)),
      CONSTRAINT risk_profiles_draft_unconfirmed_check CHECK (status <> 'draft' OR confirmed_at IS NULL),
      CONSTRAINT risk_profiles_superseded_consistency_check CHECK ((status = 'superseded') = (superseded_at IS NOT NULL))
    )`,
    `CREATE UNIQUE INDEX risk_profiles_user_version_unique ON risk_profiles (user_id, version)`,
    `CREATE UNIQUE INDEX risk_profiles_one_active_per_user_unique ON risk_profiles (user_id) WHERE status = 'active'`,
    `CREATE UNIQUE INDEX risk_profiles_one_draft_per_user_unique ON risk_profiles (user_id) WHERE status = 'draft'`,
    `CREATE INDEX risk_profiles_status_idx ON risk_profiles (status)`,
    `COMMENT ON TABLE risk_profiles IS 'Versioned user risk profiles; history is append-only'`,
  ]);
}

export async function down({ context: { sequelize } }: { context: MigrationContext }): Promise<void> {
  await executeInTransaction(sequelize, [`DROP TABLE IF EXISTS risk_profiles`]);
}
