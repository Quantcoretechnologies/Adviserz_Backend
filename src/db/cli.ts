/**
 * Database migration / seed CLI.
 *
 *   npm run db:migrate            apply all pending migrations
 *   npm run db:migrate:undo       revert the most recent migration
 *   npm run db:migrate:undo:all   revert every migration (destructive)
 *   npm run db:migrate:status     list executed / pending migrations
 *   npm run db:seed               apply pending seeders
 *   npm run db:seed:status        list executed / pending seeders
 *   npm run maintenance:cleanup   purge expired sessions / OTP records once
 *
 * Migrations never run as a side effect of starting the API; they are an
 * explicit deployment step.
 */
import { isProduction } from '../config/env.js';
import { logger } from '../config/logger.js';
import { sequelize } from './sequelize.js';
import { migrator, seeder } from './umzug.js';

async function status(runner: typeof migrator, label: string): Promise<void> {
  const executed = await runner.executed();
  const pending = await runner.pending();
  logger.info({ executed: executed.map((m) => m.name), pending: pending.map((m) => m.name) }, `${label} status`);
}

async function main(): Promise<void> {
  const command = process.argv[2];

  switch (command) {
    case 'migrate:up': {
      const applied = await migrator.up();
      logger.info({ applied: applied.map((m) => m.name) }, `Applied ${applied.length} migration(s)`);
      break;
    }
    case 'migrate:down': {
      const reverted = await migrator.down();
      logger.info({ reverted: reverted.map((m) => m.name) }, `Reverted ${reverted.length} migration(s)`);
      break;
    }
    case 'migrate:down:all': {
      if (isProduction) {
        throw new Error('Refusing to revert all migrations in production');
      }
      const reverted = await migrator.down({ to: 0 });
      logger.info({ reverted: reverted.map((m) => m.name) }, `Reverted ${reverted.length} migration(s)`);
      break;
    }
    case 'migrate:status':
      await status(migrator, 'Migration');
      break;
    case 'seed:up': {
      const applied = await seeder.up();
      logger.info({ applied: applied.map((m) => m.name) }, `Applied ${applied.length} seeder(s)`);
      break;
    }
    case 'seed:status':
      await status(seeder, 'Seeder');
      break;
    case 'maintenance:cleanup': {
      // Imported lazily: only this command needs the models.
      const { purgeExpiredAuthData } = await import('../modules/maintenance/cleanup.service.js');
      const result = await purgeExpiredAuthData();
      logger.info(result, result.skipped ? 'Cleanup skipped: another run holds the lock' : 'Cleanup completed');
      break;
    }
    default:
      throw new Error(`Unknown command "${command ?? ''}"`);
  }
}

main()
  .then(async () => {
    await sequelize.close();
    process.exit(0);
  })
  .catch(async (error: unknown) => {
    logger.error({ err: error }, 'Database command failed');
    await sequelize.close().catch(() => undefined);
    process.exit(1);
  });
