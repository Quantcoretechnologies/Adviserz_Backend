import { Router } from 'express';
import { authenticateAdmin } from '../../common/middleware/authenticate.js';
import { adminAuthLimiter } from '../../common/middleware/rateLimiters.js';
import { requireAllowedOrigin, requireCsrf } from '../../common/middleware/webSecurity.js';
import * as controller from './admin.controller.js';

/**
 * Mounted at {API_PREFIX}/admin. Super-admin console (web, cookie + CSRF).
 *
 * Auth:      POST /auth/login | /auth/refresh | /auth/logout,  GET /auth/me
 * Users:     GET /users, GET /users/:id, GET /users/:id/risk-profiles,
 *            GET /users/:id/audit-logs, POST /users/:id/block, POST /users/:id/unblock
 * Segments:  GET /segments, POST /segments, PATCH /segments/:id
 * Policies:  GET /policies, GET /policies/:id, POST /policies,
 *            PATCH /policies/:id, POST /policies/:id/publish
 * Insights:  GET /stats?days=, GET /audit-logs
 */
export const adminRouter = Router();

adminRouter.post('/auth/login', adminAuthLimiter, requireAllowedOrigin, controller.login);
adminRouter.post('/auth/refresh', adminAuthLimiter, requireAllowedOrigin, requireCsrf('admin'), controller.refresh);
adminRouter.post('/auth/logout', requireAllowedOrigin, requireCsrf('admin'), controller.logout);

const protectedRouter = Router();
protectedRouter.use(authenticateAdmin);

protectedRouter.get('/auth/me', controller.me);

protectedRouter.get('/users', controller.listUsers);
protectedRouter.get('/users/:id', controller.getUser);
protectedRouter.get('/users/:id/risk-profiles', controller.getUserRiskProfiles);
protectedRouter.get('/users/:id/audit-logs', controller.getUserAuditLogs);
protectedRouter.post('/users/:id/block', controller.blockUser);
protectedRouter.post('/users/:id/unblock', controller.unblockUser);

protectedRouter.get('/segments', controller.listSegments);
protectedRouter.post('/segments', controller.createSegment);
protectedRouter.patch('/segments/:id', controller.updateSegment);

protectedRouter.get('/policies', controller.listPolicies);
protectedRouter.get('/policies/:id', controller.getPolicy);
protectedRouter.post('/policies', controller.createPolicy);
protectedRouter.patch('/policies/:id', controller.updatePolicy);
protectedRouter.post('/policies/:id/publish', controller.publishPolicy);

protectedRouter.get('/stats', controller.stats);
protectedRouter.get('/audit-logs', controller.auditLogs);

adminRouter.use(protectedRouter);
