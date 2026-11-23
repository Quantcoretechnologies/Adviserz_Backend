import type { MigrationContext } from '../umzug.js';
import { executeInTransaction } from '../migrationUtils.js';

/**
 * Capital-band risk limits, risk acknowledgements and risk-limit change notices.
 *
 * segment_risk_rule_sets / segment_risk_bands
 *   - A segment's risk limits are a table of capital bands. A band starts at
 *     `capital_from` and runs up to just below the next band's capital; the
 *     last band has no upper end. Each band has a minimum, suggested and
 *     maximum risk percentage.
 *   - Every save of the table is a new VERSION (rule set). Versions are never
 *     changed or removed, so the limits in force at any moment stay on record.
 *     The highest version is the one in force.
 *   - `notify_users` marks versions that customers holding the segment must
 *     acknowledge (every admin change). Initial setups are silent.
 *   - The single minimum capital and risk range on `segments` are replaced:
 *     the minimum capital is the first band's `capital_from`. Each existing
 *     segment's values become its version 1 (one band, suggested = maximum).
 *
 * risk_acknowledgements
 *   - One row each time a user accepts a disclaimer for a risk choice above the
 *     suggested or the maximum level: the values, the band in force, the exact
 *     text shown (with its policy version), the typed confirmation for the
 *     strict disclaimer, and where/when it happened.
 *
 * risk_notice_acceptances / risk_notice_acceptance_segments
 *   - One row each time a user accepts a risk-limit change notice, with the
 *     whole notice as shown, plus one row per segment it covered (which
 *     version the user moved from and to, and what it meant for them).
 *
 * All five tables are append-only: a trigger rejects UPDATE, DELETE and
 * TRUNCATE, as on audit_logs.
 */
const APPEND_ONLY_TABLES = [
  'segment_risk_rule_sets',
  'segment_risk_bands',
  'risk_acknowledgements',
  'risk_notice_acceptances',
  'risk_notice_acceptance_segments',
] as const;

const appendOnlyTriggers = APPEND_ONLY_TABLES.flatMap((table) => [
  `CREATE TRIGGER ${table}_no_update_delete
     BEFORE UPDATE OR DELETE ON ${table}
     FOR EACH ROW EXECUTE FUNCTION risk_records_reject_mutation()`,
  `CREATE TRIGGER ${table}_no_truncate
     BEFORE TRUNCATE ON ${table}
     FOR EACH STATEMENT EXECUTE FUNCTION risk_records_reject_mutation()`,
]);

export async function up({ context: { sequelize } }: { context: MigrationContext }): Promise<void> {
  await executeInTransaction(sequelize, [
    `CREATE FUNCTION risk_records_reject_mutation() RETURNS trigger
       LANGUAGE plpgsql AS $$
       BEGIN
         RAISE EXCEPTION '% is append-only: % is not permitted', TG_TABLE_NAME, TG_OP
           USING ERRCODE = 'insufficient_privilege';
       END;
       $$`,

    // --- Risk bands -------------------------------------------------------
    `ALTER TABLE segments
       ADD COLUMN suggested_mode VARCHAR(20) NOT NULL DEFAULT 'manual',
       ADD CONSTRAINT segments_suggested_mode_check CHECK (suggested_mode IN ('midpoint', 'manual'))`,

    `CREATE TABLE segment_risk_rule_sets (
      id                   UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
      segment_id           UUID         NOT NULL REFERENCES segments (id) ON UPDATE CASCADE ON DELETE RESTRICT,
      version              INTEGER      NOT NULL,
      suggested_mode       VARCHAR(20)  NOT NULL,
      source               VARCHAR(20)  NOT NULL,
      notify_users         BOOLEAN      NOT NULL,
      change_summary       JSONB        NULL,
      created_by_admin_id  UUID         NULL REFERENCES admins (id) ON UPDATE CASCADE ON DELETE RESTRICT,
      created_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      CONSTRAINT segment_risk_rule_sets_version_check CHECK (version >= 1),
      CONSTRAINT segment_risk_rule_sets_suggested_mode_check CHECK (suggested_mode IN ('midpoint', 'manual')),
      CONSTRAINT segment_risk_rule_sets_source_check CHECK (source IN ('migration', 'seed', 'admin')),
      CONSTRAINT segment_risk_rule_sets_admin_check CHECK (source <> 'admin' OR created_by_admin_id IS NOT NULL)
    )`,
    `CREATE UNIQUE INDEX segment_risk_rule_sets_segment_version_unique ON segment_risk_rule_sets (segment_id, version)`,
    `CREATE INDEX segment_risk_rule_sets_notify_idx ON segment_risk_rule_sets (segment_id, version DESC) WHERE notify_users`,
    `COMMENT ON TABLE segment_risk_rule_sets IS 'Versions of each segment''s capital-band risk limits; append-only'`,

    `CREATE TABLE segment_risk_bands (
      id                      UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
      rule_set_id             UUID          NOT NULL REFERENCES segment_risk_rule_sets (id) ON UPDATE CASCADE ON DELETE RESTRICT,
      capital_from            NUMERIC(18,2) NOT NULL,
      min_risk_percent        NUMERIC(9,4)  NOT NULL,
      suggested_risk_percent  NUMERIC(9,4)  NOT NULL,
      max_risk_percent        NUMERIC(9,4)  NOT NULL,
      created_at              TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
      CONSTRAINT segment_risk_bands_capital_check CHECK (capital_from >= 0),
      CONSTRAINT segment_risk_bands_order_check
        CHECK (min_risk_percent > 0
               AND min_risk_percent <= suggested_risk_percent
               AND suggested_risk_percent <= max_risk_percent
               AND max_risk_percent <= 100)
    )`,
    `CREATE UNIQUE INDEX segment_risk_bands_rule_set_capital_unique ON segment_risk_bands (rule_set_id, capital_from)`,
    `COMMENT ON TABLE segment_risk_bands IS 'Capital bands (min / suggested / max risk %) of one rule-set version'`,

    // Each existing segment's single range becomes its version 1.
    `INSERT INTO segment_risk_rule_sets (segment_id, version, suggested_mode, source, notify_users)
       SELECT id, 1, 'manual', 'migration', FALSE FROM segments`,
    `INSERT INTO segment_risk_bands (rule_set_id, capital_from, min_risk_percent, suggested_risk_percent, max_risk_percent)
       SELECT rs.id, s.min_capital, s.min_risk_percent, s.max_risk_percent, s.max_risk_percent
         FROM segment_risk_rule_sets rs JOIN segments s ON s.id = rs.segment_id`,
    `ALTER TABLE segments
       DROP COLUMN min_capital,
       DROP COLUMN min_risk_percent,
       DROP COLUMN max_risk_percent`,

    // --- Disclaimer texts live in the versioned policy system -------------
    `ALTER TABLE policy_documents DROP CONSTRAINT policy_documents_type_check`,
    `ALTER TABLE policy_documents ADD CONSTRAINT policy_documents_type_check CHECK (type IN (
       'terms_and_conditions', 'risk_policy',
       'risk_disclaimer_above_suggested', 'risk_disclaimer_above_maximum', 'risk_limits_change_notice'))`,

    `ALTER TABLE risk_profiles DROP CONSTRAINT risk_profiles_source_check`,
    `ALTER TABLE risk_profiles ADD CONSTRAINT risk_profiles_source_check
       CHECK (source IN ('onboarding', 'profile_update', 'risk_notice'))`,

    // --- Acknowledgements ---------------------------------------------------
    `CREATE TABLE risk_acknowledgements (
      id                      UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id                 UUID          NOT NULL REFERENCES users (id) ON UPDATE CASCADE ON DELETE RESTRICT,
      segment_id              UUID          NOT NULL REFERENCES segments (id) ON UPDATE CASCADE ON DELETE RESTRICT,
      risk_profile_id         UUID          NOT NULL REFERENCES risk_profiles (id) ON UPDATE CASCADE ON DELETE RESTRICT,
      rule_set_id             UUID          NOT NULL REFERENCES segment_risk_rule_sets (id) ON UPDATE CASCADE ON DELETE RESTRICT,
      source                  VARCHAR(20)   NOT NULL,
      level                   VARCHAR(20)   NOT NULL,
      risk_basis              VARCHAR(30)   NOT NULL,
      currency                CHAR(3)       NOT NULL,
      capital                 NUMERIC(18,2) NOT NULL,
      risk_percent            NUMERIC(9,4)  NOT NULL,
      risk_amount             NUMERIC(18,2) NOT NULL,
      band_capital_from       NUMERIC(18,2) NOT NULL,
      band_min_percent        NUMERIC(9,4)  NOT NULL,
      band_suggested_percent  NUMERIC(9,4)  NOT NULL,
      band_max_percent        NUMERIC(9,4)  NOT NULL,
      previous_capital        NUMERIC(18,2) NULL,
      previous_risk_percent   NUMERIC(9,4)  NULL,
      policy_document_id      UUID          NOT NULL REFERENCES policy_documents (id) ON UPDATE CASCADE ON DELETE RESTRICT,
      policy_content_sha256   CHAR(64)      NOT NULL,
      statement               TEXT          NOT NULL,
      statement_sha256        CHAR(64)      NOT NULL,
      typed_confirmation      VARCHAR(100)  NULL,
      ip_address              VARCHAR(45)   NULL,
      user_agent              VARCHAR(512)  NULL,
      request_id              VARCHAR(64)   NULL,
      created_at              TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
      CONSTRAINT risk_acknowledgements_source_check CHECK (source IN ('onboarding', 'profile_update', 'risk_notice')),
      CONSTRAINT risk_acknowledgements_level_check CHECK (level IN ('above_suggested', 'above_maximum')),
      CONSTRAINT risk_acknowledgements_risk_basis_check CHECK (risk_basis IN ('total_capital', 'daily_loss')),
      CONSTRAINT risk_acknowledgements_values_check
        CHECK (capital > 0 AND risk_percent > 0 AND risk_percent <= 100 AND risk_amount >= 0),
      CONSTRAINT risk_acknowledgements_level_matches_check
        CHECK ((level = 'above_suggested' AND risk_percent > band_suggested_percent AND risk_percent <= band_max_percent)
            OR (level = 'above_maximum' AND risk_percent > band_max_percent)),
      CONSTRAINT risk_acknowledgements_typed_confirmation_check
        CHECK ((level = 'above_maximum') = (typed_confirmation IS NOT NULL)),
      CONSTRAINT risk_acknowledgements_sha_format_check
        CHECK (policy_content_sha256 ~ '^[0-9a-f]{64}$' AND statement_sha256 ~ '^[0-9a-f]{64}$')
    )`,
    `CREATE INDEX risk_acknowledgements_user_idx ON risk_acknowledgements (user_id, created_at DESC)`,
    `CREATE INDEX risk_acknowledgements_segment_idx ON risk_acknowledgements (segment_id, created_at DESC)`,
    `CREATE INDEX risk_acknowledgements_profile_idx ON risk_acknowledgements (risk_profile_id)`,
    `COMMENT ON TABLE risk_acknowledgements IS 'Disclaimers users accepted for risk above the suggested or maximum level; append-only'`,

    // --- Change notices -----------------------------------------------------
    `CREATE TABLE risk_notice_acceptances (
      id                     UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id                UUID          NOT NULL REFERENCES users (id) ON UPDATE CASCADE ON DELETE RESTRICT,
      risk_profile_id        UUID          NOT NULL REFERENCES risk_profiles (id) ON UPDATE CASCADE ON DELETE RESTRICT,
      notice                 JSONB         NOT NULL,
      notice_sha256          CHAR(64)      NOT NULL,
      policy_document_id     UUID          NOT NULL REFERENCES policy_documents (id) ON UPDATE CASCADE ON DELETE RESTRICT,
      policy_content_sha256  CHAR(64)      NOT NULL,
      statement              TEXT          NOT NULL,
      ip_address             VARCHAR(45)   NULL,
      user_agent             VARCHAR(512)  NULL,
      request_id             VARCHAR(64)   NULL,
      created_at             TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
      CONSTRAINT risk_notice_acceptances_sha_format_check
        CHECK (notice_sha256 ~ '^[0-9a-f]{64}$' AND policy_content_sha256 ~ '^[0-9a-f]{64}$')
    )`,
    `CREATE INDEX risk_notice_acceptances_user_idx ON risk_notice_acceptances (user_id, created_at DESC)`,
    `COMMENT ON TABLE risk_notice_acceptances IS 'Risk-limit change notices users accepted, exactly as shown; append-only'`,

    `CREATE TABLE risk_notice_acceptance_segments (
      id                        UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
      acceptance_id             UUID         NOT NULL REFERENCES risk_notice_acceptances (id) ON UPDATE CASCADE ON DELETE RESTRICT,
      user_id                   UUID         NOT NULL REFERENCES users (id) ON UPDATE CASCADE ON DELETE RESTRICT,
      segment_id                UUID         NOT NULL REFERENCES segments (id) ON UPDATE CASCADE ON DELETE RESTRICT,
      from_rule_set_id          UUID         NULL REFERENCES segment_risk_rule_sets (id) ON UPDATE CASCADE ON DELETE RESTRICT,
      to_rule_set_id            UUID         NOT NULL REFERENCES segment_risk_rule_sets (id) ON UPDATE CASCADE ON DELETE RESTRICT,
      to_version                INTEGER      NOT NULL,
      status                    VARCHAR(20)  NOT NULL,
      values_changed            BOOLEAN      NOT NULL,
      risk_acknowledgement_id   UUID         NULL REFERENCES risk_acknowledgements (id) ON UPDATE CASCADE ON DELETE RESTRICT,
      created_at                TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      CONSTRAINT risk_notice_acceptance_segments_status_check
        CHECK (status IN ('ok', 'needs_caution_ack', 'needs_strict_ack', 'must_change')),
      CONSTRAINT risk_notice_acceptance_segments_must_change_check CHECK (status <> 'must_change' OR values_changed)
    )`,
    `CREATE UNIQUE INDEX risk_notice_acceptance_segments_unique ON risk_notice_acceptance_segments (acceptance_id, segment_id)`,
    `CREATE INDEX risk_notice_acceptance_segments_user_idx ON risk_notice_acceptance_segments (user_id, segment_id, to_version DESC)`,
    `CREATE INDEX risk_notice_acceptance_segments_rule_set_idx ON risk_notice_acceptance_segments (to_rule_set_id)`,
    `COMMENT ON TABLE risk_notice_acceptance_segments IS 'Per-segment detail of each accepted risk-limit change notice; append-only'`,

    // --- Link profile values to the limits they were checked against -------
    // rule_set_id NULL = saved before risk bands existed.
    `ALTER TABLE risk_profile_segments
       ADD COLUMN rule_set_id UUID NULL REFERENCES segment_risk_rule_sets (id) ON UPDATE CASCADE ON DELETE RESTRICT,
       ADD COLUMN risk_acknowledgement_id UUID NULL REFERENCES risk_acknowledgements (id) ON UPDATE CASCADE ON DELETE RESTRICT`,
    `CREATE INDEX risk_profile_segments_rule_set_id_idx ON risk_profile_segments (rule_set_id) WHERE rule_set_id IS NOT NULL`,

    ...appendOnlyTriggers,
  ]);
}

/**
 * Restores the single range on `segments` from each segment's current
 * version: minimum capital = first band, risk range = lowest minimum to
 * highest maximum. Every acknowledgement and notice record is dropped.
 */
export async function down({ context: { sequelize } }: { context: MigrationContext }): Promise<void> {
  await executeInTransaction(sequelize, [
    `ALTER TABLE risk_profile_segments DROP COLUMN risk_acknowledgement_id, DROP COLUMN rule_set_id`,
    `DROP TABLE risk_notice_acceptance_segments`,
    `DROP TABLE risk_notice_acceptances`,
    `DROP TABLE risk_acknowledgements`,
    `ALTER TABLE segments
       ADD COLUMN min_capital      NUMERIC(18,2) NOT NULL DEFAULT 0,
       ADD COLUMN min_risk_percent NUMERIC(9,4)  NOT NULL DEFAULT 0.01,
       ADD COLUMN max_risk_percent NUMERIC(9,4)  NOT NULL DEFAULT 100`,
    `UPDATE segments s SET
        min_capital = b.min_capital, min_risk_percent = b.min_risk, max_risk_percent = b.max_risk
       FROM (
         SELECT DISTINCT ON (rs.segment_id) rs.segment_id,
                (SELECT MIN(capital_from) FROM segment_risk_bands WHERE rule_set_id = rs.id) AS min_capital,
                (SELECT MIN(min_risk_percent) FROM segment_risk_bands WHERE rule_set_id = rs.id) AS min_risk,
                (SELECT MAX(max_risk_percent) FROM segment_risk_bands WHERE rule_set_id = rs.id) AS max_risk
           FROM segment_risk_rule_sets rs
          ORDER BY rs.segment_id, rs.version DESC
       ) b
      WHERE b.segment_id = s.id`,
    `ALTER TABLE segments
       ADD CONSTRAINT segments_min_capital_check CHECK (min_capital >= 0),
       ADD CONSTRAINT segments_risk_range_check
         CHECK (min_risk_percent > 0 AND max_risk_percent <= 100 AND min_risk_percent <= max_risk_percent)`,
    `DROP TABLE segment_risk_bands`,
    `DROP TABLE segment_risk_rule_sets`,
    `ALTER TABLE segments DROP CONSTRAINT segments_suggested_mode_check, DROP COLUMN suggested_mode`,
    `DROP FUNCTION risk_records_reject_mutation()`,
    `UPDATE risk_profiles SET source = 'profile_update' WHERE source = 'risk_notice'`,
    `ALTER TABLE risk_profiles DROP CONSTRAINT risk_profiles_source_check`,
    `ALTER TABLE risk_profiles ADD CONSTRAINT risk_profiles_source_check CHECK (source IN ('onboarding', 'profile_update'))`,
    `DELETE FROM policy_documents WHERE type NOT IN ('terms_and_conditions', 'risk_policy')`,
    `ALTER TABLE policy_documents DROP CONSTRAINT policy_documents_type_check`,
    `ALTER TABLE policy_documents ADD CONSTRAINT policy_documents_type_check
       CHECK (type IN ('terms_and_conditions', 'risk_policy'))`,
  ]);
}
