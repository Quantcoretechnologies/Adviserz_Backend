import { Router } from 'express';
import { authenticateUser } from '../../common/middleware/authenticate.js';
import * as controller from './onboarding.controller.js';

/**
 * Mounted at {API_PREFIX}/onboarding. Every mutation returns the full,
 * updated onboarding state (including `nextStep`).
 *
 *   GET  /                    current state
 *   PUT  /segments            { segmentIds: uuid[] }
 *   PUT  /experience          { marketExperience }
 *   PUT  /capital             { allocations: [{ segmentId, capital }] }
 *   PUT  /risk                { allocations: [{ segmentId, riskPercent }] }
 *   POST /broker/skip
 *   POST /policies/accept     { policyDocumentIds: uuid[] }
 *   POST /confirm
 */
export const onboardingRouter = Router();

onboardingRouter.use(authenticateUser);

onboardingRouter.get('/', controller.getState);
onboardingRouter.put('/segments', controller.saveSegments);
onboardingRouter.put('/experience', controller.saveExperience);
onboardingRouter.put('/capital', controller.saveCapital);
onboardingRouter.put('/risk', controller.saveRisk);
onboardingRouter.post('/broker/skip', controller.skipBroker);
onboardingRouter.post('/policies/accept', controller.acceptPolicies);
onboardingRouter.post('/confirm', controller.confirm);
