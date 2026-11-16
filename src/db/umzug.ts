import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DataTypes, type QueryInterface, type Sequelize } from 'sequelize';
import { SequelizeStorage, Umzug } from 'umzug';
import { logger } from '../config/logger.js';
import { sequelize } from './sequelize.js';

/**
 * Context passed to every migration and seeder.
 */
export interface MigrationContext {
  queryInterface: QueryInterface;
  sequelize: Sequelize;
  DataTypes: typeof DataTypes;
}

export interface MigrationModule {
  up: (params: { context: MigrationContext }) => Promise<void>;
  down: (params: { context: MigrationContext }) => Promise<void>;
}

const here = path.dirname(fileURLToPath(import.meta.url));

// Under tsx (development) this file runs as .ts and loads .ts migrations;
// after `npm run build` it runs as .js from dist/ and loads compiled .js.
const ext = import.meta.url.endsWith('.ts') ? 'ts' : 'js';

/** fast-glob requires forward slashes, including on Windows. */
const toGlob = (dir: string): string => `${path.join(here, dir).replace(/\\/g, '/')}/*.${ext}`;

function createRunner(dir: 'migrations' | 'seeders', tableName: string): Umzug<MigrationContext> {
  return new Umzug<MigrationContext>({
    migrations: {
      glob: [toGlob(dir), { ignore: ['**/*.d.ts'] }],
      resolve: ({ name, path: filePath }) => {
        if (!filePath) throw new Error(`Missing path for migration ${name}`);
        return {
          // Record the name WITHOUT extension so .ts (dev) and .js (prod)
          // runs share one history.
          name: name.replace(/\.(ts|js)$/, ''),
          up: async ({ context }) => {
            const mod = (await import(pathToFileURL(filePath).href)) as MigrationModule;
            await mod.up({ context });
          },
          down: async ({ context }) => {
            const mod = (await import(pathToFileURL(filePath).href)) as MigrationModule;
            await mod.down({ context });
          },
        };
      },
    },
    context: { queryInterface: sequelize.getQueryInterface(), sequelize, DataTypes },
    // A distinct modelName per runner is essential: SequelizeStorage reuses an
    // already-defined model of the same name, so with the default
    // ("SequelizeMeta") seeders would silently share the migrations table.
    storage: new SequelizeStorage({ sequelize, tableName, modelName: `umzug_${tableName}` }),
    logger: {
      info: (message) => logger.info(message, `${dir}`),
      warn: (message) => logger.warn(message, `${dir}`),
      error: (message) => logger.error(message, `${dir}`),
      debug: (message) => logger.debug(message, `${dir}`),
    },
  });
}

export const migrator = createRunner('migrations', 'schema_migrations');
export const seeder = createRunner('seeders', 'seed_history');
