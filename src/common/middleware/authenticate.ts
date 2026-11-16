import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../errors/AppError.js';
import { ErrorCode } from '../errors/errorCodes.js';
import { Admin, User } from '../../models/index.js';
import { assertSessionActive } from '../../modules/auth/session.service.js';
import { extractBearerToken, verifyAccessToken } from '../../modules/auth/token.service.js';
import { assertPoliciesAccepted } from '../../modules/policies/policy.service.js';

/**
 * Authenticate a customer from `Authorization: Bearer <access token>`.
 *
 * Beyond the JWT signature, every request confirms the session is still live
 * and the account still active, so logout, password change and admin blocks
 * take effect immediately rather than when the access token expires.
 */
export async function authenticateUser(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const token = extractBearerToken(req.get('authorization'));
  if (!token) throw AppError.unauthorized('Authentication required', ErrorCode.UNAUTHENTICATED);

  const claims = verifyAccessToken('user', token);
  await assertSessionActive(claims.sid, 'user', claims.sub);

  const user = await User.findByPk(claims.sub, { attributes: ['id', 'status', 'onboardingStatus'] });
  if (!user) throw AppError.unauthorized('Access token is invalid', ErrorCode.ACCESS_TOKEN_INVALID);
  if (user.status !== 'active') {
    throw AppError.forbidden('Your account has been disabled. Please contact support', ErrorCode.ACCOUNT_DISABLED);
  }

  req.userAuth = { userId: user.id, sessionId: claims.sid, onboardingStatus: user.onboardingStatus };
  next();
}

/** Authenticate a platform admin (separate secret and audience from users). */
export async function authenticateAdmin(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const token = extractBearerToken(req.get('authorization'));
  if (!token) throw AppError.unauthorized('Authentication required', ErrorCode.UNAUTHENTICATED);

  const claims = verifyAccessToken('admin', token);
  await assertSessionActive(claims.sid, 'admin', claims.sub);

  const admin = await Admin.findByPk(claims.sub, { attributes: ['id', 'status'] });
  if (!admin) throw AppError.unauthorized('Access token is invalid', ErrorCode.ACCESS_TOKEN_INVALID);
  if (admin.status !== 'active') {
    throw AppError.forbidden('This admin account has been disabled', ErrorCode.ACCOUNT_DISABLED);
  }

  req.adminAuth = { adminId: admin.id, sessionId: claims.sid };
  next();
}

/**
 * Gate for every feature beyond onboarding. Until onboarding is confirmed the
 * user may only reach profile, onboarding, policy and session endpoints.
 */
export function requireOnboardingCompleted(req: Request, _res: Response, next: NextFunction): void {
  if (req.userAuth?.onboardingStatus !== 'completed') {
    throw AppError.forbidden('Please complete onboarding to continue', ErrorCode.ONBOARDING_REQUIRED);
  }
  next();
}

/** After onboarding: block until the latest published policies are accepted. */
export async function requireCurrentPoliciesAccepted(req: Request, _res: Response, next: NextFunction): Promise<void> {
  if (!req.userAuth) throw AppError.unauthorized();
  await assertPoliciesAccepted(req.userAuth.userId);
  next();
}

/** Narrow `req.userAuth` for handlers mounted behind authenticateUser. */
export function requireUserAuth(req: Request): NonNullable<Request['userAuth']> {
  if (!req.userAuth) throw AppError.unauthorized();
  return req.userAuth;
}

/** Narrow `req.adminAuth` for handlers mounted behind authenticateAdmin. */
export function requireAdminAuth(req: Request): NonNullable<Request['adminAuth']> {
  if (!req.adminAuth) throw AppError.unauthorized();
  return req.adminAuth;
}
