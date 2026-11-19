import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { AppError } from '../../common/errors/AppError.js';
import { ErrorCode } from '../../common/errors/errorCodes.js';
import { authenticateAdmin } from '../../common/middleware/authenticate.js';
import { requirePermission } from '../../common/middleware/requirePermission.js';
import type { PermissionKey } from '../access/permissionCatalog.js';

/**
 * For the few endpoints every signed-in admin may call whatever their roles
 * (their own profile, the permission catalog). Using it is a deliberate,
 * visible choice; everything else must name a permission.
 */
export const AUTHENTICATED_ONLY = Symbol('authenticated-only');

export type RouteAccess = PermissionKey | typeof AUTHENTICATED_ONLY;

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';

export interface GuardedRouteOptions {
  /**
   * Reachable while the admin still has a generated password. Only the
   * endpoints needed to change it should set this.
   */
  allowedBeforePasswordChange?: boolean;
}

export interface GuardedRoute {
  method: Method;
  path: string;
  access: RouteAccess;
  allowedBeforePasswordChange: boolean;
}

/**
 * Staff created with a generated password can do nothing until they replace
 * it, so a password seen by the creator never stays in use.
 */
function requirePasswordChanged(req: Request, _res: Response, next: NextFunction): void {
  if (req.adminAuth?.mustChangePassword) {
    throw AppError.forbidden('Change your temporary password to continue', ErrorCode.PASSWORD_CHANGE_REQUIRED);
  }
  next();
}

/**
 * A router for signed-in admin endpoints that cannot register a route without
 * stating who may call it. The underlying Express router is only handed out
 * for mounting, so there is no way to add an unguarded route by accident.
 */
export function createGuardedAdminRouter() {
  const router = Router();
  router.use(authenticateAdmin);
  const routes: GuardedRoute[] = [];

  const register =
    (method: Method) =>
    (path: string, access: RouteAccess, handler: RequestHandler, options: GuardedRouteOptions = {}): void => {
      const allowedBeforePasswordChange = options.allowedBeforePasswordChange ?? false;
      routes.push({ method, path, access, allowedBeforePasswordChange });
      const guards: RequestHandler[] = [];
      if (!allowedBeforePasswordChange) guards.push(requirePasswordChanged);
      if (access !== AUTHENTICATED_ONLY) guards.push(requirePermission(access));
      router[method](path, ...guards, handler);
    };

  return {
    router,
    /** Every registered route with its access rule, for tests and tooling. */
    routes: routes as readonly GuardedRoute[],
    get: register('get'),
    post: register('post'),
    put: register('put'),
    patch: register('patch'),
    delete: register('delete'),
  };
}
