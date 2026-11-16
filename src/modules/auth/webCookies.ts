import type { CookieOptions, Request, Response } from 'express';
import { env } from '../../config/env.js';
import { generateOpaqueToken } from '../../common/utils/crypto.js';
import type { SubjectType } from './token.service.js';

/**
 * Web clients keep the refresh token in an HttpOnly cookie that JavaScript
 * cannot read. Because browsers attach cookies automatically, every
 * cookie-authenticated endpoint is CSRF-protected with the double-submit
 * pattern: a random CSRF token is set in a readable cookie AND returned in the
 * response body, and must be echoed back in the X-CSRF-Token header.
 */
interface CookieNames {
  refresh: string;
  csrf: string;
  refreshPath: string;
}

function names(subjectType: SubjectType): CookieNames {
  return subjectType === 'admin'
    ? { refresh: 'adz_admin_rt', csrf: 'adz_admin_csrf', refreshPath: `${env.API_PREFIX}/admin/auth` }
    : { refresh: 'adz_rt', csrf: 'adz_csrf', refreshPath: `${env.API_PREFIX}/auth/web` };
}

function baseOptions(expires: Date): CookieOptions {
  return {
    secure: env.COOKIE_SECURE,
    sameSite: env.COOKIE_SAMESITE,
    expires,
    ...(env.COOKIE_DOMAIN ? { domain: env.COOKIE_DOMAIN } : {}),
  };
}

/** Set refresh + CSRF cookies; returns the CSRF token for the response body. */
export function setAuthCookies(res: Response, subjectType: SubjectType, refreshToken: string, expires: Date): string {
  const cookie = names(subjectType);
  const csrfToken = generateOpaqueToken();
  res.cookie(cookie.refresh, refreshToken, { ...baseOptions(expires), httpOnly: true, path: cookie.refreshPath });
  res.cookie(cookie.csrf, csrfToken, { ...baseOptions(expires), httpOnly: false, path: '/' });
  return csrfToken;
}

export function clearAuthCookies(res: Response, subjectType: SubjectType): void {
  const cookie = names(subjectType);
  const domain = env.COOKIE_DOMAIN ? { domain: env.COOKIE_DOMAIN } : {};
  res.clearCookie(cookie.refresh, {
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: env.COOKIE_SAMESITE,
    path: cookie.refreshPath,
    ...domain,
  });
  res.clearCookie(cookie.csrf, { secure: env.COOKIE_SECURE, sameSite: env.COOKIE_SAMESITE, path: '/', ...domain });
}

export function readRefreshCookie(req: Request, subjectType: SubjectType): string | null {
  const value: unknown = req.cookies?.[names(subjectType).refresh];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function readCsrfCookie(req: Request, subjectType: SubjectType): string | null {
  const value: unknown = req.cookies?.[names(subjectType).csrf];
  return typeof value === 'string' && value.length > 0 ? value : null;
}
