import { createServer } from 'node:http';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { sequelize } from './db/sequelize.js';
import { migrator } from './db/umzug.js';
import { createApp } from './app.js';
import { startCleanupScheduler } from './modules/maintenance/cleanup.service.js';

const SHUTDOWN_TIMEOUT_MS = 15_000;

async function main(): Promise<void> {
  await sequelize.authenticate();
  logger.info({ host: env.DB_HOST, database: env.DB_NAME }, 'Database connection established');

  // Migrations are a deployment step, never run on boot — but refuse to serve
  // against a schema that is behind the code.
  const pending = await migrator.pending();
  if (pending.length > 0) {
    logger.fatal({ pending: pending.map((m) => m.name) }, 'Pending migrations detected. Run `npm run db:migrate` first');
    await sequelize.close();
    process.exit(1);
  }

  const app = createApp();
  const server = createServer(app);
  server.keepAliveTimeout = 65_000; // above typical load balancer idle timeout (60s)
  server.headersTimeout = 66_000;

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(env.PORT, () => {
      server.off('error', reject);
      resolve();
    });
  });
  logger.info({ port: env.PORT, env: env.NODE_ENV, prefix: env.API_PREFIX }, 'Adviserz API listening');

  const stopCleanup = startCleanupScheduler();

  let shuttingDown = false;
  const shutdown = (signal: string, exitCode = 0): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down gracefully');
    stopCleanup();

    const forceExit = setTimeout(() => {
      logger.error('Graceful shutdown timed out; forcing exit');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceExit.unref();

    server.close((closeError) => {
      if (closeError) logger.error({ err: closeError }, 'Error while closing HTTP server');
      sequelize
        .close()
        .catch((error: unknown) => logger.error({ err: error }, 'Error while closing database pool'))
        .finally(() => process.exit(exitCode));
    });
    server.closeIdleConnections();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    logger.fatal({ err: reason }, 'Unhandled promise rejection');
    shutdown('unhandledRejection', 1);
  });
  process.on('uncaughtException', (error) => {
    logger.fatal({ err: error }, 'Uncaught exception');
    shutdown('uncaughtException', 1);
  });
}

main().catch(async (error: unknown) => {
  logger.fatal({ err: error }, 'Failed to start server');
  await sequelize.close().catch(() => undefined);
  process.exit(1);
});
