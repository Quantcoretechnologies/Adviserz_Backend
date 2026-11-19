/**
 * End-to-end test harness.
 *
 * Builds a throwaway PostgreSQL database from scratch (drop -> create ->
 * migrate -> seed), boots the real Express app on a random port and returns
 * handles to it. Nothing is mocked except where a test explicitly overrides
 * the OTP delivery provider.
 *
 * SAFETY: the database name must end in "_test". The harness refuses to run
 * otherwise, because it DROPS that database on every run.
 */
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import pg from 'pg';
import type { Sequelize } from 'sequelize';
import type { OtpSender } from '../../src/modules/notifications/otpSender.js';
import type { VerificationChannel } from '../../src/models/enums.js';
import type { CleanupResult } from '../../src/modules/maintenance/cleanup.service.js';

export const TEST_ORIGIN = 'http://localhost:3000';
export const TEST_OTP = '123456';
export const TEST_ADMIN = { email: 'e2e.admin@example.test', password: 'E2e-Admin-Pass#2026', name: 'E2E Admin' };
/** Short windows so time-based behaviour can be tested quickly. */
export const TEST_OTP_COOLDOWN_SECONDS = 2;
export const TEST_REFRESH_GRACE_SECONDS = 1;

export interface TestEnvironment {
  baseUrl: string;
  apiUrl: string;
  sequelize: Sequelize;
  overrideOtpSender: (channel: VerificationChannel, sender: OtpSender | null) => void;
  purgeExpiredAuthData: (now?: Date) => Promise<CleanupResult>;
  close: () => Promise<void>;
}

function configureEnvironment(): string {
  const dbName = process.env['TEST_DB_NAME'] ?? 'adviserz_test';
  if (!/_test$/.test(dbName)) {
    throw new Error(`Refusing to run: test database name "${dbName}" must end with "_test"`);
  }

  // Values the suite depends on are forced; they win over .env because
  // process.loadEnvFile never overrides variables that are already set.
  const forced: Record<string, string> = {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DB_NAME: dbName,
    CORS_ALLOWED_ORIGINS: TEST_ORIGIN,
    COOKIE_SECURE: 'false',
    COOKIE_SAMESITE: 'strict',
    SMS_PROVIDER: 'static',
    EMAIL_PROVIDER: 'static',
    STATIC_OTP_CODE: TEST_OTP,
    OTP_RESEND_COOLDOWN_SECONDS: String(TEST_OTP_COOLDOWN_SECONDS),
    OTP_MAX_SENDS_PER_HOUR: '5',
    OTP_MAX_ATTEMPTS: '5',
    LOGIN_MAX_FAILED_ATTEMPTS: '5',
    REFRESH_TOKEN_REUSE_GRACE_SECONDS: String(TEST_REFRESH_GRACE_SECONDS),
    CLEANUP_INTERVAL_MINUTES: '0',
    AUTH_DATA_RETENTION_DAYS: '30',
    RATE_LIMIT_GLOBAL_MAX: '100000',
    RATE_LIMIT_AUTH_MAX: '100000',
    RATE_LIMIT_OTP_MAX: '100000',
    RATE_LIMIT_ADMIN_AUTH_MAX: '100000',
    SUPER_ADMIN_NAME: TEST_ADMIN.name,
    SUPER_ADMIN_EMAIL: TEST_ADMIN.email,
    SUPER_ADMIN_PASSWORD: TEST_ADMIN.password,
  };
  Object.assign(process.env, forced);

  // Database credentials come from the environment (CI) or the local .env.
  const envFile = path.resolve(process.cwd(), '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);

  // Secrets: ephemeral per run when not provided.
  for (const key of ['JWT_ACCESS_SECRET', 'JWT_ADMIN_ACCESS_SECRET', 'OTP_HMAC_SECRET']) {
    if (!process.env[key]) process.env[key] = randomBytes(48).toString('base64url');
  }
  return dbName;
}

async function recreateDatabase(dbName: string): Promise<void> {
  const client = new pg.Client({
    host: process.env['DB_HOST'],
    port: Number(process.env['DB_PORT'] ?? 5432),
    user: process.env['DB_USER'],
    password: process.env['DB_PASSWORD'],
    database: 'postgres',
  });
  await client.connect();
  try {
    const quoted = `"${dbName.replace(/"/g, '""')}"`;
    await client.query(`DROP DATABASE IF EXISTS ${quoted} WITH (FORCE)`);
    await client.query(`CREATE DATABASE ${quoted} ENCODING 'UTF8'`);
  } finally {
    await client.end();
  }
}

export async function startTestEnvironment(): Promise<TestEnvironment> {
  const dbName = configureEnvironment();
  await recreateDatabase(dbName);

  // Application modules are imported only now, after the environment is set,
  // because config/env.ts validates process.env at import time.
  const { sequelize } = await import('../../src/db/sequelize.js');
  const { migrator, seeder } = await import('../../src/db/umzug.js');
  const { createApp } = await import('../../src/app.js');
  const { overrideOtpSender } = await import('../../src/modules/notifications/otpSender.js');
  const { purgeExpiredAuthData } = await import('../../src/modules/maintenance/cleanup.service.js');

  const { syncPermissionCatalog } = await import('../../src/modules/access/access.service.js');

  await migrator.up();
  await seeder.up();
  // The server does this at start (server.ts); the suite boots the app directly.
  await syncPermissionCatalog();

  const server: Server = createServer(createApp());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    baseUrl,
    apiUrl: `${baseUrl}/api/v1`,
    sequelize,
    overrideOtpSender,
    purgeExpiredAuthData,
    close: async () => {
      await new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
      await sequelize.close();
    },
  };
}
