import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../errors/AppError.js';
import { ErrorCode } from '../errors/errorCodes.js';
import { Admin, User } from '../../models/index.js';
import { getEffectivePermissions } from '../../modules/access/access.service.js';
import { assertSessionActive } from '../../modules/auth/session.service.js';
import { extractBearerToken, verifyAccessToken } from '../../modules/auth/token.service.js';
import { assertPoliciesAccepted } from '../../modules/policies/policy.service.js';
import { assertNoPendingRiskNotice } from '../../modules/riskRules/riskNotice.service.js';

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

/**
 * Authenticate a platform admin (separate secret and audience from users).
 *
 * The admin's permissions are loaded from the database on every request, so
 * a role change, a block or a deletion takes effect immediately. What each
 * route needs is enforced by requirePermission.
 */
export async function authenticateAdmin(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const token = extractBearerToken(req.get('authorization'));
  if (!token) throw AppError.unauthorized('Authentication required', ErrorCode.UNAUTHENTICATED);

  const claims = verifyAccessToken('admin', token);
  await assertSessionActive(claims.sid, 'admin', claims.sub);

  const admin = await Admin.findByPk(claims.sub, { attributes: ['id', 'status', 'isDeleted', 'isSuperAdmin', 'mustChangePassword'],
  });
  // A deleted account is indistinguishable from one that never existed.
  if (!admin || admin.isDeleted) {
    throw AppError.unauthorized('Access token is invalid', ErrorCode.ACCESS_TOKEN_INVALID);
  }
  if (admin.status !== 'active') {
    throw AppError.forbidden('This admin account has been disabled', ErrorCode.ACCOUNT_DISABLED);
  }

  req.adminAuth = {
    adminId: admin.id,
    sessionId: claims.sid,
    isSuperAdmin: admin.isSuperAdmin,
    mustChangePassword: admin.mustChangePassword,
    permissions: await getEffectivePermissions(admin.id, admin.isSuperAdmin),
  };
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

/**
 * After onboarding: block until any risk-limit change notice for the user's
 * segments is accepted (see riskNotice.service).
 */
export async function requireRiskNoticeAccepted(req: Request, _res: Response, next: NextFunction): Promise<void> {
  if (!req.userAuth) throw AppError.unauthorized();
  await assertNoPendingRiskNotice(req.userAuth.userId);
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
