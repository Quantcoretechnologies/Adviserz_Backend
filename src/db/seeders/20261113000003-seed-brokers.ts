import type { MigrationContext } from '../umzug.js';
import { executeInTransaction } from '../migrationUtils.js';

/** Broker master list. All inactive until their integrations are built. */
const BROKERS = [
  ['ZERODHA', 'Zerodha', 1],
  ['UPSTOX', 'Upstox', 2],
  ['ANGEL_ONE', 'Angel One', 3],
  ['DHAN', 'Dhan', 4],
  ['FYERS', 'Fyers', 5],
] as const;

export async function up({ context: { sequelize } }: { context: MigrationContext }): Promise<void> {
  await sequelize.transaction(async (transaction) => {
    for (const [code, name, displayOrder] of BROKERS) {
      await sequelize.query(
        `INSERT INTO brokers (code, name, is_active, display_order)
         VALUES (:code, :name, FALSE, :displayOrder)
         ON CONFLICT (code) DO NOTHING`,
        { replacements: { code, name, displayOrder }, transaction },
      );
    }
  });
}

export async function down({ context: { sequelize } }: { context: MigrationContext }): Promise<void> {
  await executeInTransaction(sequelize, [
    `DELETE FROM brokers WHERE code IN (${BROKERS.map(([code]) => `'${code}'`).join(', ')})`,
  ]);
}
