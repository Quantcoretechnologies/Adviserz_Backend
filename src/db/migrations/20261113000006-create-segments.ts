import type { MigrationContext } from '../umzug.js';
import { executeInTransaction } from '../migrationUtils.js';

/**
 * Trading segments (master list, admin-managed). Users pick from active
 * segments; they can never create one.
 *
 * risk_basis decides what the user's risk percentage means:
 *   - total_capital: maximum loss as a % of the whole capital (e.g. Delivery)
 *   - daily_loss:    maximum loss per trading day as a % of capital (Intraday, F&O)
 *
 * Money is NUMERIC(18,2); percentages are NUMERIC(9,4). Never floats.
 */
export async function up({ context: { sequelize } }: { context: MigrationContext }): Promise<void> {
  await executeInTransaction(sequelize, [
    `CREATE TABLE segments (
      id                   UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
      code                 VARCHAR(50)   NOT NULL,
      name                 VARCHAR(100)  NOT NULL,
      description          VARCHAR(500)  NULL,
      risk_basis           VARCHAR(30)   NOT NULL,
      min_capital          NUMERIC(18,2) NOT NULL DEFAULT 0,
      min_risk_percent     NUMERIC(9,4)  NOT NULL DEFAULT 0.01,
      max_risk_percent     NUMERIC(9,4)  NOT NULL DEFAULT 100,
      currency             CHAR(3)       NOT NULL DEFAULT 'INR',
      is_active            BOOLEAN       NOT NULL DEFAULT TRUE,
      display_order        INTEGER       NOT NULL DEFAULT 0,
      created_by_admin_id  UUID          NULL REFERENCES admins (id) ON UPDATE CASCADE ON DELETE SET NULL,
      updated_by_admin_id  UUID          NULL REFERENCES admins (id) ON UPDATE CASCADE ON DELETE SET NULL,
      created_at           TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
      updated_at           TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
      CONSTRAINT segments_code_format_check CHECK (code ~ '^[A-Z][A-Z0-9_]{1,49}$'),
      CONSTRAINT segments_risk_basis_check CHECK (risk_basis IN ('total_capital', 'daily_loss')),
      CONSTRAINT segments_min_capital_check CHECK (min_capital >= 0),
      CONSTRAINT segments_risk_range_check
        CHECK (min_risk_percent > 0 AND max_risk_percent <= 100 AND min_risk_percent <= max_risk_percent),
      CONSTRAINT segments_currency_format_check CHECK (currency ~ '^[A-Z]{3}$')
    )`,
    `CREATE UNIQUE INDEX segments_code_unique ON segments (code)`,
    `CREATE UNIQUE INDEX segments_name_lower_unique ON segments (LOWER(name))`,
    `CREATE INDEX segments_active_order_idx ON segments (is_active, display_order)`,
    `CREATE INDEX segments_created_by_admin_id_idx ON segments (created_by_admin_id) WHERE created_by_admin_id IS NOT NULL`,
    `CREATE INDEX segments_updated_by_admin_id_idx ON segments (updated_by_admin_id) WHERE updated_by_admin_id IS NOT NULL`,
    `COMMENT ON TABLE segments IS 'Admin-managed trading segments with capital/risk limits'`,
  ]);
}

export async function down({ context: { sequelize } }: { context: MigrationContext }): Promise<void> {
  await executeInTransaction(sequelize, [`DROP TABLE IF EXISTS segments`]);
}
