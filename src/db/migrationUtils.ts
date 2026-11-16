import type { Sequelize } from 'sequelize';

/**
 * Execute SQL statements inside a single transaction.
 *
 * PostgreSQL supports transactional DDL, so a migration either applies
 * completely or not at all — a failure halfway through never leaves the
 * schema in a partially-migrated state.
 */
export async function executeInTransaction(sequelize: Sequelize, statements: readonly string[]): Promise<void> {
  await sequelize.transaction(async (transaction) => {
    for (const statement of statements) {
      await sequelize.query(statement, { transaction });
    }
  });
}
