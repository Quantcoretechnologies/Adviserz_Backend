import type { NextFunction, Request, Response } from 'express';
import { env } from '../../config/env.js';
import { AppError } from '../errors/AppError.js';
import { ErrorCode } from '../errors/errorCodes.js';
import { readCsrfCookie } from '../../modules/auth/webCookies.js';
import type { SubjectType } from '../../modules/auth/token.service.js';
import { safeEqualHex, sha256Hex } from '../utils/crypto.js';

/**
 * Reject browser requests from origins not on the allow-list. Applied to
 * cookie-based web auth endpoints; a missing Origin (non-browser client) is
 * allowed through, because CSRF requires a browser.
 */
export function requireAllowedOrigin(req: Request, _res: Response, next: NextFunction): void {
  const origin = req.get('origin');
  if (origin && !env.CORS_ALLOWED_ORIGINS.includes(origin)) {
    next(AppError.forbidden('Origin not allowed', ErrorCode.CSRF_TOKEN_INVALID));
    return;
  }
  next();
}

/**
 * Double-submit CSRF check: the X-CSRF-Token header must equal the CSRF
 * cookie. A cross-site attacker can make the browser send cookies but cannot
 * read them, so cannot produce the matching header.
 */
export function requireCsrf(subjectType: SubjectType) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const header = req.get('x-csrf-token');
    const cookie = readCsrfCookie(req, subjectType);
    // Compare digests so the comparison is constant-time and length-independent.
    if (!header || !cookie || !safeEqualHex(sha256Hex(header), sha256Hex(cookie))) {
      next(AppError.forbidden('CSRF token missing or invalid', ErrorCode.CSRF_TOKEN_INVALID));
      return;
    }
    next();
  };
}
