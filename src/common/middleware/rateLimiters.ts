import type { Request, Response } from 'express';
import { rateLimit, type Options } from 'express-rate-limit';
import { env } from '../../config/env.js';
import { ErrorCode } from '../errors/errorCodes.js';

/**
 * Per-IP rate limits. These use the in-process memory store, which is correct
 * for a single instance. When running more than one instance, plug in a shared
 * store (e.g. rate-limit-redis) via `store` — per-destination OTP throttling
 * is already enforced in the database and is unaffected.
 */
function limiter(windowMs: number, limit: number, message: string) {
  const options: Partial<Options> = {
    windowMs,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (req: Request, res: Response) => {
      res.status(429).json({
        success: false,
        message,
        code: ErrorCode.RATE_LIMITED,
        data: null,
        requestId: req.requestId,
      });
    },
  };
  return rateLimit(options);
}

const WINDOW = 15 * 60 * 1000;

/** Baseline for every API route. */
export const globalLimiter = limiter(WINDOW, env.RATE_LIMIT_GLOBAL_MAX, 'Too many requests, please try again later');

/** Login / refresh / register / password reset. */
export const authLimiter = limiter(
  WINDOW,
  env.RATE_LIMIT_AUTH_MAX,
  'Too many authentication attempts, please try again later',
);

/** OTP send + verify (on top of per-destination DB throttling). */
export const otpLimiter = limiter(WINDOW, env.RATE_LIMIT_OTP_MAX, 'Too many verification attempts, please try again later');

/** Admin login / refresh. */
export const adminAuthLimiter = limiter(
  WINDOW,
  env.RATE_LIMIT_ADMIN_AUTH_MAX,
  'Too many authentication attempts, please try again later',
);
