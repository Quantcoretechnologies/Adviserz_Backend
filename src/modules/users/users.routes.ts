import { Router } from 'express';
import {
  authenticateUser,
  requireCurrentPoliciesAccepted,
  requireOnboardingCompleted,
  requireRiskNoticeAccepted,
} from '../../common/middleware/authenticate.js';
import * as controller from './users.controller.js';

/**
 * Mounted at {API_PREFIX}/users/me. All routes require a user access token.
 *
 * Always available (even before onboarding / policy re-acceptance):
 *   GET    /                         profile + outstanding requirements
 *   PATCH  /                         { fullName?, username? }
 *   POST   /password                 { currentPassword, newPassword, confirmPassword }
 *   GET    /sessions
 *   DELETE /sessions/:sessionId
 *   POST   /sessions/revoke-others
 *   POST   /sessions/revoke-all
 *   GET    /policies                 pending policy versions
 *   POST   /policies/accept          { policyDocumentIds }
 *   POST   /risk-assessment          { allocations: [{ segmentId, capital, riskPercent }] }  check values, get disclaimers
 *
 * After onboarding:
 *   GET    /risk-notice              pending risk-limit change notice (required: false when none)
 *   POST   /risk-notice/accept       { noticeSha256, policyDocumentId, segments?: [{ segmentId, capital?, riskPercent?, acknowledgement? }] }
 *
 * After onboarding + current policies accepted + no pending risk notice:
 *   GET    /risk-profile
 *   GET    /risk-profile/history?page=&pageSize=
 *   PUT    /risk-profile             { marketExperience, allocations: [{ segmentId, capital, riskPercent, acknowledgement? }] }
 */
export const usersRouter = Router();

usersRouter.use(authenticateUser);

usersRouter.get('/', controller.getMe);
usersRouter.patch('/', controller.updateMe);
usersRouter.post('/password', controller.changePassword);

usersRouter.get('/sessions', controller.listSessions);
usersRouter.post('/sessions/revoke-others', controller.revokeOtherSessions);
usersRouter.post('/sessions/revoke-all', controller.revokeAllSessions);
usersRouter.delete('/sessions/:sessionId', controller.revokeSession);

usersRouter.get('/policies', controller.getPolicyStatus);
usersRouter.post('/policies/accept', controller.acceptPolicies);
usersRouter.post('/risk-assessment', controller.assessRisk);

usersRouter.get('/risk-notice', requireOnboardingCompleted, controller.getRiskNotice);
usersRouter.post('/risk-notice/accept', requireOnboardingCompleted, controller.acceptRiskNotice);

const riskProfileRouter = Router();
riskProfileRouter.use(requireOnboardingCompleted, requireCurrentPoliciesAccepted, requireRiskNoticeAccepted);
riskProfileRouter.get('/', controller.getRiskProfile);
riskProfileRouter.get('/history', controller.getRiskProfileHistory);
riskProfileRouter.put('/', controller.updateRiskProfile);

usersRouter.use('/risk-profile', riskProfileRouter);
