import type { Request, Response } from 'express';
import { AppError } from '../../common/errors/AppError.js';
import { ErrorCode } from '../../common/errors/errorCodes.js';
import { requireAdminAuth } from '../../common/middleware/authenticate.js';
import { getRequestContext } from '../../common/http/requestContext.js';
import { sendCreated, sendSuccess } from '../../common/http/response.js';
import { paginationQuery, parseInput, uuidParam } from '../../common/utils/validation.js';
import { clearAuthCookies, readRefreshCookie, setAuthCookies } from '../auth/webCookies.js';
import type { IssuedTokens } from '../auth/session.service.js';
import { describeCatalogFor } from '../access/access.service.js';
import * as authService from './adminAuth.service.js';
import * as insights from './adminInsights.service.js';
import * as policies from './adminPolicies.service.js';
import * as riskRules from './adminRiskRules.service.js';
import * as roles from './adminRoles.service.js';
import * as staff from './adminStaff.service.js';
import * as segments from './adminSegments.service.js';
import * as users from './adminUsers.service.js';
import {
  adminLoginBody,
  blockStaffBody,
  blockUserBody,
  changeAdminPasswordBody,
  createRoleBody,
  createStaffBody,
  listRolesQuery,
  listStaffQuery,
  previewQuery,
  riskRuleAcceptancesQuery,
  riskRulesBody,
  riskRuleVersionParams,
  setStaffRolesBody,
  updateRoleBody,
  updateStaffBody,
  createPolicyBody,
  createSegmentBody,
  listAuditLogsQuery,
  listPoliciesQuery,
  listUsersQuery,
  statsQuery,
  updatePolicyBody,
  updateSegmentBody,
} from './admin.schemas.js';

function tokenResponse(res: Response, tokens: IssuedTokens) {
  const csrfToken = setAuthCookies(res, 'admin', tokens.refreshToken, tokens.refreshTokenExpiresAt);
  return {
    tokenType: 'Bearer' as const,
    accessToken: tokens.accessToken,
    accessTokenExpiresAt: tokens.accessTokenExpiresAt,
    refreshTokenExpiresAt: tokens.refreshTokenExpiresAt,
    sessionId: tokens.sessionId,
    csrfToken,
  };
}

// Auth --------------------------------------------------------------------

export async function login(req: Request, res: Response): Promise<void> {
  const { email, password } = parseInput(adminLoginBody, req.body);
  const result = await authService.loginAdmin(email, password, getRequestContext(req));
  sendSuccess(res, { ...tokenResponse(res, result.tokens), admin: result.admin }, 'Signed in successfully');
}

export async function refresh(req: Request, res: Response): Promise<void> {
  const refreshToken = readRefreshCookie(req, 'admin');
  if (!refreshToken) throw AppError.unauthorized('Refresh token is missing', ErrorCode.REFRESH_TOKEN_INVALID);
  try {
    const tokens = await authService.refreshAdminSession(refreshToken, getRequestContext(req));
    sendSuccess(res, tokenResponse(res, tokens), 'Session refreshed');
  } catch (error) {
    if (error instanceof AppError && error.statusCode === 401) clearAuthCookies(res, 'admin');
    throw error;
  }
}

export async function logout(req: Request, res: Response): Promise<void> {
  await authService.logoutAdmin(readRefreshCookie(req, 'admin'), getRequestContext(req));
  clearAuthCookies(res, 'admin');
  sendSuccess(res, null, 'Signed out successfully');
}

export async function me(req: Request, res: Response): Promise<void> {
  const { adminId, permissions } = requireAdminAuth(req);
  sendSuccess(res, {
    admin: await authService.getAdminProfile(adminId),
    // What the console may show this admin. The API enforces each one itself.
    permissions: [...permissions].sort(),
  });
}

export async function changePassword(req: Request, res: Response): Promise<void> {
  const { adminId, sessionId } = requireAdminAuth(req);
  const { currentPassword, newPassword } = parseInput(changeAdminPasswordBody, req.body);
  const result = await authService.changeAdminPassword(adminId, sessionId, { currentPassword, newPassword }, getRequestContext(req));
  sendSuccess(res, result, 'Password changed');
}

// Access ------------------------------------------------------------------

export async function permissionCatalog(req: Request, res: Response): Promise<void> {
  const { permissions } = requireAdminAuth(req);
  sendSuccess(res, { modules: describeCatalogFor(permissions) });
}

// Roles -------------------------------------------------------------------

export async function listRoles(req: Request, res: Response): Promise<void> {
  sendSuccess(res, await roles.listRoles(requireAdminAuth(req), parseInput(listRolesQuery, req.query)));
}

export async function getRole(req: Request, res: Response): Promise<void> {
  const { id } = parseInput(uuidParam, req.params);
  sendSuccess(res, { role: await roles.getRole(requireAdminAuth(req), id) });
}

export async function createRole(req: Request, res: Response): Promise<void> {
  const body = parseInput(createRoleBody, req.body);
  sendCreated(res, { role: await roles.createRole(requireAdminAuth(req), body, getRequestContext(req)) }, 'Role created');
}

export async function updateRole(req: Request, res: Response): Promise<void> {
  const { id } = parseInput(uuidParam, req.params);
  const body = parseInput(updateRoleBody, req.body);
  const { preview } = parseInput(previewQuery, req.query);
  const result = await roles.updateRole(requireAdminAuth(req), id, body, getRequestContext(req), { preview });
  sendSuccess(res, result, preview ? 'Preview only: nothing was changed' : 'Role updated');
}

export async function roleDeletionImpact(req: Request, res: Response): Promise<void> {
  const { id } = parseInput(uuidParam, req.params);
  const result = await roles.deleteRole(requireAdminAuth(req), id, getRequestContext(req), { preview: true });
  sendSuccess(res, result, 'Preview only: nothing was changed');
}

export async function deleteRole(req: Request, res: Response): Promise<void> {
  const { id } = parseInput(uuidParam, req.params);
  const result = await roles.deleteRole(requireAdminAuth(req), id, getRequestContext(req), { preview: false });
  sendSuccess(res, result, 'Role deleted');
}

// Staff -------------------------------------------------------------------

export async function listStaff(req: Request, res: Response): Promise<void> {
  sendSuccess(res, await staff.listStaff(requireAdminAuth(req), parseInput(listStaffQuery, req.query)));
}

export async function staffTree(req: Request, res: Response): Promise<void> {
  sendSuccess(res, await staff.getStaffTree(requireAdminAuth(req)));
}

export async function getStaff(req: Request, res: Response): Promise<void> {
  const { id } = parseInput(uuidParam, req.params);
  sendSuccess(res, await staff.getStaff(requireAdminAuth(req), id));
}

export async function createStaff(req: Request, res: Response): Promise<void> {
  const body = parseInput(createStaffBody, req.body);
  // The generated password is in this response only: never cache it.
  res.setHeader('Cache-Control', 'no-store');
  sendCreated(res, await staff.createStaff(requireAdminAuth(req), body, getRequestContext(req)), 'Staff account created');
}

export async function updateStaff(req: Request, res: Response): Promise<void> {
  const { id } = parseInput(uuidParam, req.params);
  const body = parseInput(updateStaffBody, req.body);
  sendSuccess(res, { staff: await staff.updateStaff(requireAdminAuth(req), id, body, getRequestContext(req)) }, 'Staff updated');
}

export async function setStaffRoles(req: Request, res: Response): Promise<void> {
  const { id } = parseInput(uuidParam, req.params);
  const { roleIds } = parseInput(setStaffRolesBody, req.body);
  const { preview } = parseInput(previewQuery, req.query);
  const result = await staff.setStaffRoles(requireAdminAuth(req), id, roleIds, getRequestContext(req), { preview });
  sendSuccess(res, result, preview ? 'Preview only: nothing was changed' : 'Roles updated');
}

export async function staffDeletionImpact(req: Request, res: Response): Promise<void> {
  const { id } = parseInput(uuidParam, req.params);
  const result = await staff.deleteStaff(requireAdminAuth(req), id, getRequestContext(req), { preview: true });
  sendSuccess(res, result, 'Preview only: nothing was changed');
}

export async function deleteStaff(req: Request, res: Response): Promise<void> {
  const { id } = parseInput(uuidParam, req.params);
  const result = await staff.deleteStaff(requireAdminAuth(req), id, getRequestContext(req), { preview: false });
  sendSuccess(res, result, 'Staff member deleted');
}

export async function blockStaff(req: Request, res: Response): Promise<void> {
  const { id } = parseInput(uuidParam, req.params);
  const { reason } = parseInput(blockStaffBody, req.body);
  sendSuccess(res, { staff: await staff.blockStaff(requireAdminAuth(req), id, reason, getRequestContext(req)) }, 'Staff member blocked');
}

export async function unblockStaff(req: Request, res: Response): Promise<void> {
  const { id } = parseInput(uuidParam, req.params);
  sendSuccess(res, { staff: await staff.unblockStaff(requireAdminAuth(req), id, getRequestContext(req)) }, 'Staff member unblocked');
}

export async function resetStaffPassword(req: Request, res: Response): Promise<void> {
  const { id } = parseInput(uuidParam, req.params);
  res.setHeader('Cache-Control', 'no-store');
  sendSuccess(res, await staff.resetStaffPassword(requireAdminAuth(req), id, getRequestContext(req)), 'Password reset');
}

// Users -------------------------------------------------------------------

export async function listUsers(req: Request, res: Response): Promise<void> {
  sendSuccess(res, await users.listUsers(parseInput(listUsersQuery, req.query)));
}

export async function getUser(req: Request, res: Response): Promise<void> {
  const { id } = parseInput(uuidParam, req.params);
  sendSuccess(res, await users.getUserDetail(id));
}

export async function getUserRiskProfiles(req: Request, res: Response): Promise<void> {
  const { id } = parseInput(uuidParam, req.params);
  const { page, pageSize } = parseInput(paginationQuery, req.query);
  sendSuccess(res, await users.getUserRiskProfileHistory(id, page, pageSize));
}

export async function getUserRiskAcknowledgements(req: Request, res: Response): Promise<void> {
  const { id } = parseInput(uuidParam, req.params);
  const { page, pageSize } = parseInput(paginationQuery, req.query);
  sendSuccess(res, await riskRules.getUserRiskAcknowledgements(id, page, pageSize));
}

export async function getUserRiskNoticeAcceptances(req: Request, res: Response): Promise<void> {
  const { id } = parseInput(uuidParam, req.params);
  const { page, pageSize } = parseInput(paginationQuery, req.query);
  sendSuccess(res, await riskRules.getUserRiskNoticeAcceptances(id, page, pageSize));
}

export async function getUserAuditLogs(req: Request, res: Response): Promise<void> {
  const { id } = parseInput(uuidParam, req.params);
  const query = parseInput(listAuditLogsQuery, req.query);
  sendSuccess(res, await insights.listAuditLogs({ ...query, subjectUserId: id }));
}

export async function blockUser(req: Request, res: Response): Promise<void> {
  const { adminId } = requireAdminAuth(req);
  const { id } = parseInput(uuidParam, req.params);
  const { reason } = parseInput(blockUserBody, req.body);
  sendSuccess(res, { user: await users.blockUser(adminId, id, reason, getRequestContext(req)) }, 'User blocked');
}

export async function unblockUser(req: Request, res: Response): Promise<void> {
  const { adminId } = requireAdminAuth(req);
  const { id } = parseInput(uuidParam, req.params);
  sendSuccess(res, { user: await users.unblockUser(adminId, id, getRequestContext(req)) }, 'User unblocked');
}

// Segments ----------------------------------------------------------------

export async function listSegments(_req: Request, res: Response): Promise<void> {
  sendSuccess(res, { items: await segments.listAllSegments() });
}

export async function createSegment(req: Request, res: Response): Promise<void> {
  const { adminId } = requireAdminAuth(req);
  const body = parseInput(createSegmentBody, req.body);
  sendCreated(res, { segment: await segments.createSegment(adminId, body, getRequestContext(req)) }, 'Segment created');
}

export async function updateSegment(req: Request, res: Response): Promise<void> {
  const { adminId } = requireAdminAuth(req);
  const { id } = parseInput(uuidParam, req.params);
  const body = parseInput(updateSegmentBody, req.body);
  sendSuccess(res, { segment: await segments.updateSegment(adminId, id, body, getRequestContext(req)) }, 'Segment updated');
}

export async function getRiskRules(req: Request, res: Response): Promise<void> {
  const { id } = parseInput(uuidParam, req.params);
  sendSuccess(res, await riskRules.getRiskRules(id));
}

export async function getRiskRuleVersion(req: Request, res: Response): Promise<void> {
  const { id, version } = parseInput(riskRuleVersionParams, req.params);
  sendSuccess(res, { ruleSet: await riskRules.getRiskRuleVersion(id, version) });
}

export async function saveRiskRules(req: Request, res: Response): Promise<void> {
  const { adminId } = requireAdminAuth(req);
  const { id } = parseInput(uuidParam, req.params);
  const body = parseInput(riskRulesBody, req.body);
  const { preview } = parseInput(previewQuery, req.query);
  const result = await riskRules.saveRiskRules(adminId, id, body, getRequestContext(req), { preview });
  sendSuccess(res, result, preview ? 'Preview only: nothing was changed' : 'Risk bands saved. Customers holding this segment will be asked to accept the change');
}

export async function getRiskRuleAcceptances(req: Request, res: Response): Promise<void> {
  const { id, version } = parseInput(riskRuleVersionParams, req.params);
  const query = parseInput(riskRuleAcceptancesQuery, req.query);
  sendSuccess(res, await riskRules.getRiskRuleAcceptances(id, version, query));
}

// Policies ----------------------------------------------------------------

export async function listPolicies(req: Request, res: Response): Promise<void> {
  sendSuccess(res, { items: await policies.listPolicies(parseInput(listPoliciesQuery, req.query)) });
}

export async function getPolicy(req: Request, res: Response): Promise<void> {
  const { id } = parseInput(uuidParam, req.params);
  sendSuccess(res, { policy: await policies.getPolicy(id) });
}

export async function createPolicy(req: Request, res: Response): Promise<void> {
  const { adminId } = requireAdminAuth(req);
  const body = parseInput(createPolicyBody, req.body);
  sendCreated(res, { policy: await policies.createPolicyDraft(adminId, body, getRequestContext(req)) }, 'Draft created');
}

export async function updatePolicy(req: Request, res: Response): Promise<void> {
  const { adminId } = requireAdminAuth(req);
  const { id } = parseInput(uuidParam, req.params);
  const body = parseInput(updatePolicyBody, req.body);
  sendSuccess(res, { policy: await policies.updatePolicyDraft(adminId, id, body, getRequestContext(req)) }, 'Draft updated');
}

export async function publishPolicy(req: Request, res: Response): Promise<void> {
  const { adminId } = requireAdminAuth(req);
  const { id } = parseInput(uuidParam, req.params);
  sendSuccess(
    res,
    { policy: await policies.publishPolicy(adminId, id, getRequestContext(req)) },
    'Policy published. Users will be asked to accept it',
  );
}

// Insights ----------------------------------------------------------------

export async function stats(req: Request, res: Response): Promise<void> {
  const { days } = parseInput(statsQuery, req.query);
  sendSuccess(res, await insights.getOverview(days));
}

export async function auditLogs(req: Request, res: Response): Promise<void> {
  sendSuccess(res, await insights.listAuditLogs(parseInput(listAuditLogsQuery, req.query)));
}
