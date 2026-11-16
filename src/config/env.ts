import { existsSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

/**
 * Environment configuration, validated once at process start.
 *
 * Any missing or malformed variable aborts the process before the HTTP server
 * or database connection is created, so a misconfigured deploy fails loudly
 * instead of serving broken traffic.
 */

// Load `.env` for local development using Node's built-in loader. In
// production, variables come from the runtime (container / secrets manager)
// and no file is expected. Variables already set in the process win.
const envFile = path.resolve(process.cwd(), '.env');
if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

const booleanString = z.enum(['true', 'false']).transform((value) => value === 'true');

const csv = z.string().transform((value) =>
  value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0),
);

const emptyToUndefined = (value: unknown): unknown => (value === '' ? undefined : value);

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    API_PREFIX: z.string().startsWith('/').default('/api/v1'),
    /** Number of reverse-proxy hops in front of the app (0 = direct). Drives req.ip. */
    TRUST_PROXY: z.coerce.number().int().min(0).default(0),

    // Database
    DB_HOST: z.string().min(1),
    DB_PORT: z.coerce.number().int().min(1).max(65535).default(5432),
    DB_NAME: z.string().min(1),
    DB_USER: z.string().min(1),
    DB_PASSWORD: z.string().min(1),
    DB_SSL: booleanString.default(false),
    DB_SSL_REJECT_UNAUTHORIZED: booleanString.default(true),
    DB_POOL_MAX: z.coerce.number().int().min(1).default(10),
    DB_POOL_MIN: z.coerce.number().int().min(0).default(0),
    DB_LOG_SQL: booleanString.default(false),

    // CORS / cookies (web clients)
    CORS_ALLOWED_ORIGINS: csv.default([]),
    COOKIE_DOMAIN: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
    COOKIE_SECURE: booleanString.default(true),
    COOKIE_SAMESITE: z.enum(['strict', 'lax', 'none']).default('strict'),

    // Tokens
    JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
    JWT_ADMIN_ACCESS_SECRET: z.string().min(32, 'JWT_ADMIN_ACCESS_SECRET must be at least 32 characters'),
    JWT_ISSUER: z.string().min(1).default('adviserz-api'),
    ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
    SESSION_MAX_AGE_DAYS: z.coerce.number().int().min(1).max(365).default(90),
    ADMIN_REFRESH_TOKEN_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(12),
    /**
     * A refresh token presented again within this many seconds of being
     * rotated is treated as a benign race (e.g. two browser tabs refreshing at
     * once) and rejected WITHOUT revoking the session. Later reuse is treated
     * as theft and revokes the session. 0 = strict (always revoke).
     */
    REFRESH_TOKEN_REUSE_GRACE_SECONDS: z.coerce.number().int().min(0).max(60).default(10),

    // Maintenance: purge of expired sessions / OTP records
    /** How often the in-process cleanup runs. 0 disables it (use `npm run maintenance:cleanup` from a scheduler). */
    CLEANUP_INTERVAL_MINUTES: z.coerce.number().int().min(0).max(1440).default(60),
    /** Ended sessions and finished OTP requests are kept this long, then deleted. */
    AUTH_DATA_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(30),

    // OTP / verification
    OTP_HMAC_SECRET: z.string().min(32, 'OTP_HMAC_SECRET must be at least 32 characters'),
    SMS_PROVIDER: z.enum(['static']).default('static'),
    EMAIL_PROVIDER: z.enum(['static']).default('static'),
    STATIC_OTP_CODE: z.string().regex(/^\d{6}$/, 'STATIC_OTP_CODE must be 6 digits').default('123456'),
    OTP_TTL_SECONDS: z.coerce.number().int().min(60).max(900).default(300),
    OTP_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(5),
    OTP_RESEND_COOLDOWN_SECONDS: z.coerce.number().int().min(0).default(60),
    OTP_MAX_SENDS_PER_HOUR: z.coerce.number().int().min(1).default(5),
    VERIFICATION_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),

    // Login protection
    LOGIN_MAX_FAILED_ATTEMPTS: z.coerce.number().int().min(1).default(5),
    LOGIN_LOCKOUT_MINUTES: z.coerce.number().int().min(1).default(15),

    // Per-IP rate limits (requests per 15-minute window)
    RATE_LIMIT_GLOBAL_MAX: z.coerce.number().int().min(1).default(600),
    RATE_LIMIT_AUTH_MAX: z.coerce.number().int().min(1).default(30),
    RATE_LIMIT_OTP_MAX: z.coerce.number().int().min(1).default(20),
    RATE_LIMIT_ADMIN_AUTH_MAX: z.coerce.number().int().min(1).default(10),

    // Seed: super admin. Only read by `npm run db:seed`, which validates them
    // strictly; they must not block the API or migrations from starting.
    SUPER_ADMIN_EMAIL: z.preprocess(emptyToUndefined, z.string().optional()),
    SUPER_ADMIN_PASSWORD: z.preprocess(emptyToUndefined, z.string().optional()),
    SUPER_ADMIN_NAME: z.preprocess(emptyToUndefined, z.string().optional()),
  })
  .superRefine((env, ctx) => {
    // Browsers silently drop SameSite=None cookies that are not Secure, which
    // would break web sign-in in a way that is hard to diagnose.
    if (env.COOKIE_SAMESITE === 'none' && !env.COOKIE_SECURE) {
      ctx.addIssue({
        code: 'custom',
        path: ['COOKIE_SAMESITE'],
        message: 'COOKIE_SAMESITE=none requires COOKIE_SECURE=true',
      });
    }

    if (env.JWT_ACCESS_SECRET === env.JWT_ADMIN_ACCESS_SECRET) {
      ctx.addIssue({
        code: 'custom',
        path: ['JWT_ADMIN_ACCESS_SECRET'],
        message: 'User and admin JWT secrets must differ',
      });
    }

    if (env.NODE_ENV !== 'production') return;

    // Static OTP providers accept a fixed, publicly known code. They must
    // never be reachable in production, so fail closed at boot.
    if (env.SMS_PROVIDER === 'static') {
      ctx.addIssue({ code: 'custom', path: ['SMS_PROVIDER'], message: 'Static OTP provider is forbidden in production' });
    }
    if (env.EMAIL_PROVIDER === 'static') {
      ctx.addIssue({ code: 'custom', path: ['EMAIL_PROVIDER'], message: 'Static OTP provider is forbidden in production' });
    }
    if (!env.COOKIE_SECURE) {
      ctx.addIssue({ code: 'custom', path: ['COOKIE_SECURE'], message: 'COOKIE_SECURE must be true in production' });
    }
    if (env.CORS_ALLOWED_ORIGINS.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['CORS_ALLOWED_ORIGINS'],
        message: 'CORS_ALLOWED_ORIGINS must be set in production',
      });
    }
  });

export type Env = z.infer<typeof EnvSchema>;

function loadEnv(): Env {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    // The logger depends on env, so write directly to stderr here.
    process.stderr.write(`Invalid environment configuration:\n${details}\n`);
    process.exit(1);
  }
  return Object.freeze(parsed.data);
}

export const env: Env = loadEnv();

export const isProduction = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';
