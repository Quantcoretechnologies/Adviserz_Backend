import { Router } from 'express';
import { adminAuthLimiter } from '../../common/middleware/rateLimiters.js';
import { requireAllowedOrigin, requireCsrf } from '../../common/middleware/webSecurity.js';
import * as controller from './admin.controller.js';
import { AUTHENTICATED_ONLY, createGuardedAdminRouter } from './guardedRouter.js';

/**
 * Mounted at {API_PREFIX}/admin. Admin console (web, cookie + CSRF).
 *
 * Every signed-in route names the permission it needs (see
 * modules/access/permissionCatalog.ts). A super admin holds all of them;
 * other staff hold what their roles grant.
 *
 * Auth:      POST /auth/login | /auth/refresh | /auth/logout,  GET /auth/me,
 *            POST /auth/change-password
 * Access:    GET /permissions
 * Roles:     GET /roles, GET /roles/:id, POST /roles, PATCH /roles/:id[?preview=true],
 *            GET /roles/:id/deletion-impact, DELETE /roles/:id
 * Staff:     GET /staff, GET /staff/tree, GET /staff/:id, POST /staff, PATCH /staff/:id,
 *            PUT /staff/:id/roles[?preview=true], POST /staff/:id/block | /unblock | /reset-password,
 *            GET /staff/:id/deletion-impact, DELETE /staff/:id
 * Users:     GET /users, GET /users/:id, GET /users/:id/risk-profiles,
 *            GET /users/:id/risk-acknowledgements, GET /users/:id/risk-notice-acceptances,
 *            GET /users/:id/audit-logs, POST /users/:id/block, POST /users/:id/unblock
 * Segments:  GET /segments, POST /segments, PATCH /segments/:id,
 *            GET /segments/:id/risk-rules, GET /segments/:id/risk-rules/:version,
 *            PUT /segments/:id/risk-rules[?preview=true],
 *            GET /segments/:id/risk-rules/:version/acceptances?status=&page=&pageSize=
 * Policies:  GET /policies, GET /policies/:id, POST /policies,
 *            PATCH /policies/:id, POST /policies/:id/publish
 * Insights:  GET /stats?days=, GET /audit-logs
 */
export const adminRouter = Router();

adminRouter.post('/auth/login', adminAuthLimiter, requireAllowedOrigin, controller.login);
adminRouter.post('/auth/refresh', adminAuthLimiter, requireAllowedOrigin, requireCsrf('admin'), controller.refresh);
adminRouter.post('/auth/logout', requireAllowedOrigin, requireCsrf('admin'), controller.logout);

const guarded = createGuardedAdminRouter();

// The only two endpoints reachable with a generated password still in place.
guarded.get('/auth/me', AUTHENTICATED_ONLY, controller.me, { allowedBeforePasswordChange: true });
guarded.post('/auth/change-password', AUTHENTICATED_ONLY, controller.changePassword, {
  allowedBeforePasswordChange: true,
});
guarded.get('/permissions', AUTHENTICATED_ONLY, controller.permissionCatalog);

guarded.get('/roles', 'roles.view', controller.listRoles);
guarded.get('/roles/:id', 'roles.view', controller.getRole);
guarded.post('/roles', 'roles.create', controller.createRole);
guarded.patch('/roles/:id', 'roles.edit', controller.updateRole);
guarded.get('/roles/:id/deletion-impact', 'roles.delete', controller.roleDeletionImpact);
guarded.delete('/roles/:id', 'roles.delete', controller.deleteRole);

guarded.get('/staff', 'staff.view', controller.listStaff);
guarded.get('/staff/tree', 'staff.view', controller.staffTree);
guarded.get('/staff/:id', 'staff.view', controller.getStaff);
guarded.post('/staff', 'staff.create', controller.createStaff);
guarded.patch('/staff/:id', 'staff.edit', controller.updateStaff);
guarded.put('/staff/:id/roles', 'roles.assign', controller.setStaffRoles);
guarded.post('/staff/:id/block', 'staff.block', controller.blockStaff);
guarded.post('/staff/:id/unblock', 'staff.unblock', controller.unblockStaff);
guarded.post('/staff/:id/reset-password', 'staff.reset_password', controller.resetStaffPassword);
guarded.get('/staff/:id/deletion-impact', 'staff.delete', controller.staffDeletionImpact);
guarded.delete('/staff/:id', 'staff.delete', controller.deleteStaff);

guarded.get('/users', 'users.view', controller.listUsers);
guarded.get('/users/:id', 'users.view', controller.getUser);
guarded.get('/users/:id/risk-profiles', 'users.view_risk_profiles', controller.getUserRiskProfiles);
guarded.get('/users/:id/risk-acknowledgements', 'users.view_risk_profiles', controller.getUserRiskAcknowledgements);
guarded.get('/users/:id/risk-notice-acceptances', 'users.view_risk_profiles', controller.getUserRiskNoticeAcceptances);
guarded.get('/users/:id/audit-logs', 'users.view_activity', controller.getUserAuditLogs);
guarded.post('/users/:id/block', 'users.block', controller.blockUser);
guarded.post('/users/:id/unblock', 'users.unblock', controller.unblockUser);

guarded.get('/segments', 'segments.view', controller.listSegments);
guarded.post('/segments', 'segments.create', controller.createSegment);
guarded.patch('/segments/:id', 'segments.edit', controller.updateSegment);
guarded.get('/segments/:id/risk-rules', 'segments.view', controller.getRiskRules);
guarded.get('/segments/:id/risk-rules/:version', 'segments.view', controller.getRiskRuleVersion);
guarded.put('/segments/:id/risk-rules', 'segments.edit', controller.saveRiskRules);
guarded.get('/segments/:id/risk-rules/:version/acceptances', 'segments.view', controller.getRiskRuleAcceptances);

guarded.get('/policies', 'policies.view', controller.listPolicies);
guarded.get('/policies/:id', 'policies.view', controller.getPolicy);
guarded.post('/policies', 'policies.create', controller.createPolicy);
guarded.patch('/policies/:id', 'policies.edit', controller.updatePolicy);
guarded.post('/policies/:id/publish', 'policies.publish', controller.publishPolicy);

guarded.get('/stats', 'analytics.view', controller.stats);
guarded.get('/audit-logs', 'audit_logs.view', controller.auditLogs);

adminRouter.use(guarded.router);

/** Signed-in admin routes with their access rules (used by the test suite). */
export const guardedAdminRoutes = guarded.routes;
