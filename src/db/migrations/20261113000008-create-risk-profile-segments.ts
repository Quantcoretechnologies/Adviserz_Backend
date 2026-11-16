import type { MigrationContext } from '../umzug.js';
import { executeInTransaction } from '../migrationUtils.js';

/**
 * Per-segment capital and risk for one risk-profile version.
 *
 * capital / risk_percent are nullable only so the onboarding draft can be
 * filled step by step; the service refuses to confirm a profile while any is
 * missing. risk_basis and currency are snapshotted from the segment so history
 * stays meaningful if an admin later edits the segment.
 */
export async function up({ context: { sequelize } }: { context: MigrationContext }): Promise<void> {
  await executeInTransaction(sequelize, [
    `CREATE TABLE risk_profile_segments (
      id               UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
      risk_profile_id  UUID          NOT NULL REFERENCES risk_profiles (id) ON UPDATE CASCADE ON DELETE CASCADE,
      segment_id       UUID          NOT NULL REFERENCES segments (id) ON UPDATE CASCADE ON DELETE RESTRICT,
      risk_basis       VARCHAR(30)   NOT NULL,
      currency         CHAR(3)       NOT NULL DEFAULT 'INR',
      capital          NUMERIC(18,2) NULL,
      risk_percent     NUMERIC(9,4)  NULL,
      created_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
      updated_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
      CONSTRAINT risk_profile_segments_risk_basis_check CHECK (risk_basis IN ('total_capital', 'daily_loss')),
      CONSTRAINT risk_profile_segments_currency_format_check CHECK (currency ~ '^[A-Z]{3}$'),
      CONSTRAINT risk_profile_segments_capital_check CHECK (capital IS NULL OR capital > 0),
      CONSTRAINT risk_profile_segments_risk_percent_check
        CHECK (risk_percent IS NULL OR (risk_percent > 0 AND risk_percent <= 100))
    )`,
    `CREATE UNIQUE INDEX risk_profile_segments_profile_segment_unique
       ON risk_profile_segments (risk_profile_id, segment_id)`,
    `CREATE INDEX risk_profile_segments_segment_id_idx ON risk_profile_segments (segment_id)`,
    `COMMENT ON TABLE risk_profile_segments IS 'Capital and risk per segment for a risk-profile version'`,
  ]);
}

export async function down({ context: { sequelize } }: { context: MigrationContext }): Promise<void> {
  await executeInTransaction(sequelize, [`DROP TABLE IF EXISTS risk_profile_segments`]);
}
