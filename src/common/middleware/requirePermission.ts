import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../errors/AppError.js';
import { ErrorCode } from '../errors/errorCodes.js';
import { getRequestContext } from '../http/requestContext.js';
import { recordAuditIndependently } from '../../modules/audit/audit.service.js';
import { AuditAction } from '../../modules/audit/auditActions.js';
import type { PermissionKey } from '../../modules/access/permissionCatalog.js';

/**
 * Allow the request only when the signed-in admin holds `permission`.
 * Must be mounted behind authenticateAdmin, which loads the permissions fresh
 * from the database. A refusal is written to the audit trail.
 */
export function requirePermission(permission: PermissionKey) {
  return async function permissionGuard(req: Request, _res: Response, next: NextFunction): Promise<void> {
    const auth = req.adminAuth;
    if (!auth) throw AppError.unauthorized();

    if (!auth.permissions.has(permission)) {
      await recordAuditIndependently({
        actor: { type: 'admin', id: auth.adminId },
        action: AuditAction.ADMIN_PERMISSION_DENIED,
        severity: 'warning',
        outcome: 'failure',
        metadata: { permission, method: req.method, path: req.originalUrl.split('?')[0] },
        context: getRequestContext(req),
      });
      throw AppError.forbidden('You do not have permission to do this', ErrorCode.INSUFFICIENT_PERMISSIONS);
    }
    next();
  };
}
