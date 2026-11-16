import { pino, type LoggerOptions } from 'pino';
import { env, isProduction, isTest } from './env.js';

/**
 * Paths that must never reach log storage; pino replaces their values with
 * "[REDACTED]". Request bodies are never logged by the HTTP logger; this list
 * guards headers and any object passed explicitly to the logger.
 */
const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-csrf-token"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.newPassword',
  '*.currentPassword',
  '*.confirmPassword',
  '*.otp',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.verificationToken',
  '*.resetToken',
];

const options: LoggerOptions = {
  level: env.LOG_LEVEL,
  base: { service: 'adviserz-api', env: env.NODE_ENV },
  redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
  timestamp: pino.stdTimeFunctions.isoTime,
};

// Pretty printing runs in a worker thread; it is for humans at a terminal
// only. Production and tests write plain JSON synchronously.
export const logger = isProduction || isTest
  ? pino(options)
  : pino({
      ...options,
      transport: {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'SYS:standard', ignore: 'pid,hostname,service,env' },
      },
    });
