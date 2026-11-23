import type { Request, Response } from 'express';
import { requireUserAuth } from '../../common/middleware/authenticate.js';
import { getRequestContext } from '../../common/http/requestContext.js';
import { sendSuccess } from '../../common/http/response.js';
import { paginationQuery, parseInput } from '../../common/utils/validation.js';
import * as riskProfileService from '../riskProfile/riskProfile.service.js';
import { assessRisk as assessRiskValues, riskAssessmentBody } from '../riskRules/riskAssessment.service.js';
import * as riskNoticeService from '../riskRules/riskNotice.service.js';
import * as service from './users.service.js';
import {
  acceptPoliciesBody,
  changePasswordBody,
  sessionIdParam,
  updateProfileBody,
  updateRiskProfileBody,
} from './users.schemas.js';

export async function getMe(req: Request, res: Response): Promise<void> {
  const { userId } = requireUserAuth(req);
  sendSuccess(res, await service.getMe(userId));
}

export async function updateMe(req: Request, res: Response): Promise<void> {
  const { userId } = requireUserAuth(req);
  const body = parseInput(updateProfileBody, req.body);
  const user = await service.updateProfile(userId, body, getRequestContext(req));
  sendSuccess(res, { user }, 'Profile updated');
}

export async function changePassword(req: Request, res: Response): Promise<void> {
  const { userId, sessionId } = requireUserAuth(req);
  const { currentPassword, newPassword } = parseInput(changePasswordBody, req.body);
  const result = await service.changePassword(
    userId,
    sessionId,
    { currentPassword, newPassword },
    getRequestContext(req),
  );
  sendSuccess(res, result, 'Password changed. Other devices have been signed out');
}

export async function listSessions(req: Request, res: Response): Promise<void> {
  const { userId, sessionId } = requireUserAuth(req);
  sendSuccess(res, { items: await service.listSessions(userId, sessionId) });
}

export async function revokeSession(req: Request, res: Response): Promise<void> {
  const { userId } = requireUserAuth(req);
  const { sessionId } = parseInput(sessionIdParam, req.params);
  await service.revokeOwnSession(userId, sessionId, getRequestContext(req));
  sendSuccess(res, null, 'Session signed out');
}

export async function revokeOtherSessions(req: Request, res: Response): Promise<void> {
  const { userId, sessionId } = requireUserAuth(req);
  sendSuccess(res, await service.revokeSessions(userId, sessionId, true, getRequestContext(req)), 'Other devices signed out');
}

export async function revokeAllSessions(req: Request, res: Response): Promise<void> {
  const { userId, sessionId } = requireUserAuth(req);
  sendSuccess(res, await service.revokeSessions(userId, sessionId, false, getRequestContext(req)), 'All devices signed out');
}

export async function getRiskProfile(req: Request, res: Response): Promise<void> {
  const { userId } = requireUserAuth(req);
  sendSuccess(res, await riskProfileService.getActiveRiskProfile(userId));
}

export async function getRiskProfileHistory(req: Request, res: Response): Promise<void> {
  const { userId } = requireUserAuth(req);
  const { page, pageSize } = parseInput(paginationQuery, req.query);
  sendSuccess(res, await riskProfileService.getRiskProfileHistory(userId, page, pageSize));
}

export async function updateRiskProfile(req: Request, res: Response): Promise<void> {
  const { userId } = requireUserAuth(req);
  const body = parseInput(updateRiskProfileBody, req.body);
  sendSuccess(res, await riskProfileService.updateRiskProfile(userId, body, getRequestContext(req)), 'Risk profile updated');
}

export async function getPolicyStatus(req: Request, res: Response): Promise<void> {
  const { userId } = requireUserAuth(req);
  sendSuccess(res, await service.getPolicyStatus(userId));
}

export async function acceptPolicies(req: Request, res: Response): Promise<void> {
  const { userId } = requireUserAuth(req);
  const { policyDocumentIds } = parseInput(acceptPoliciesBody, req.body);
  sendSuccess(res, await service.acceptCurrentPolicies(userId, policyDocumentIds, getRequestContext(req)), 'Policies accepted');
}

export async function assessRisk(req: Request, res: Response): Promise<void> {
  requireUserAuth(req);
  const body = parseInput(riskAssessmentBody, req.body);
  sendSuccess(res, await assessRiskValues(body));
}

export async function getRiskNotice(req: Request, res: Response): Promise<void> {
  const { userId } = requireUserAuth(req);
  sendSuccess(res, await riskNoticeService.getRiskNotice(userId));
}

export async function acceptRiskNotice(req: Request, res: Response): Promise<void> {
  const { userId } = requireUserAuth(req);
  const body = parseInput(riskNoticeService.acceptRiskNoticeBody, req.body);
  sendSuccess(res, await riskNoticeService.acceptRiskNotice(userId, body, getRequestContext(req)), 'Risk limit update accepted');
}
