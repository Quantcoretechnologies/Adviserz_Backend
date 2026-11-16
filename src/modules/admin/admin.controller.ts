import type { Request, Response } from 'express';
import { AppError } from '../../common/errors/AppError.js';
import { ErrorCode } from '../../common/errors/errorCodes.js';
import { requireAdminAuth } from '../../common/middleware/authenticate.js';
import { getRequestContext } from '../../common/http/requestContext.js';
import { sendCreated, sendSuccess } from '../../common/http/response.js';
import { paginationQuery, parseInput, uuidParam } from '../../common/utils/validation.js';
import { clearAuthCookies, readRefreshCookie, setAuthCookies } from '../auth/webCookies.js';
import type { IssuedTokens } from '../auth/session.service.js';
import * as authService from './adminAuth.service.js';
import * as insights from './adminInsights.service.js';
import * as policies from './adminPolicies.service.js';
import * as segments from './adminSegments.service.js';
import * as users from './adminUsers.service.js';
import {
  adminLoginBody,
  blockUserBody,
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
  const { adminId } = requireAdminAuth(req);
  sendSuccess(res, { admin: await authService.getAdminProfile(adminId) });
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
