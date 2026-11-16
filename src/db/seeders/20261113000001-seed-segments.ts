import type { MigrationContext } from '../umzug.js';
import { executeInTransaction } from '../migrationUtils.js';

/**
 * Initial trading segments. Minimum capital starts at 0 and risk at the full
 * 0.01–100% range: the admin console sets the real limits.
 *
 * Hedging is intentionally NOT seeded: its risk basis is not defined yet, and
 * risk_basis is immutable once a segment exists. Create it from the admin
 * console when the rules are decided.
 */
const SEGMENTS = [
  ['EQUITY_DELIVERY', 'Equity Delivery', 'Long-term equity holdings', 'total_capital', 1],
  ['EQUITY_INTRADAY', 'Equity Intraday', 'Same-day equity trades', 'daily_loss', 2],
  ['FNO_STOCK', 'F&O (Stock)', 'Futures & options on individual stocks', 'daily_loss', 3],
  ['FNO_INDEX', 'F&O (Index)', 'Futures & options on indices', 'daily_loss', 4],
] as const;

export async function up({ context: { sequelize } }: { context: MigrationContext }): Promise<void> {
  await sequelize.transaction(async (transaction) => {
    for (const [code, name, description, riskBasis, displayOrder] of SEGMENTS) {
      await sequelize.query(
        `INSERT INTO segments (code, name, description, risk_basis, display_order)
         VALUES (:code, :name, :description, :riskBasis, :displayOrder)
         ON CONFLICT (code) DO NOTHING`,
        { replacements: { code, name, description, riskBasis, displayOrder }, transaction },
      );
    }
  });
}

export async function down({ context: { sequelize } }: { context: MigrationContext }): Promise<void> {
  // Fails (FK RESTRICT) if any risk profile references these segments — by design.
  await executeInTransaction(sequelize, [
    `DELETE FROM segments WHERE code IN (${SEGMENTS.map(([code]) => `'${code}'`).join(', ')})`,
  ]);
}
