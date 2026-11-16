import { Sequelize, type Options } from 'sequelize';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';

const dialectOptions: NonNullable<Options['dialectOptions']> = {
  // Return NUMERIC/DECIMAL as strings (pg default) — never coerce money or
  // percentages to JS floats. See common/utils/decimal.ts.
  application_name: 'adviserz-api',
};

if (env.DB_SSL) {
  Object.assign(dialectOptions, {
    ssl: { require: true, rejectUnauthorized: env.DB_SSL_REJECT_UNAUTHORIZED },
  });
}

/**
 * The single Sequelize instance for the process. Models are registered on it
 * by models/index.ts; nothing connects until the first query or an explicit
 * `authenticate()` call from the server bootstrap.
 */
export const sequelize = new Sequelize(env.DB_NAME, env.DB_USER, env.DB_PASSWORD, {
  host: env.DB_HOST,
  port: env.DB_PORT,
  dialect: 'postgres',
  dialectOptions,
  timezone: '+00:00',
  logging: env.DB_LOG_SQL ? (sql: string) => logger.debug({ sql }, 'sql') : false,
  benchmark: env.DB_LOG_SQL,
  pool: {
    max: env.DB_POOL_MAX,
    min: env.DB_POOL_MIN,
    idle: 10_000,
    acquire: 30_000,
    evict: 10_000,
  },
  retry: {
    max: 3,
    match: [
      /SequelizeConnectionError/,
      /SequelizeConnectionRefusedError/,
      /SequelizeHostNotFoundError/,
      /SequelizeHostNotReachableError/,
      /ETIMEDOUT/,
      /ECONNRESET/,
    ],
  },
  define: {
    underscored: true,
    timestamps: true,
    freezeTableName: true,
  },
});
