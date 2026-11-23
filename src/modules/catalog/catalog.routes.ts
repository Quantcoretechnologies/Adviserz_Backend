import { Router, type Request, type Response } from 'express';
import { sendSuccess } from '../../common/http/response.js';
import { listActiveBrokers, serializeBroker } from '../brokers/broker.service.js';
import { getCurrentPolicies, serializePolicy } from '../policies/policy.service.js';
import { listActiveSegments, serializeSegmentWithRules } from '../segments/segment.service.js';

/**
 * Public reference data (no authentication), mounted at {API_PREFIX}.
 *
 *   GET /segments           active trading segments with their capital-band risk limits
 *   GET /policies/current   current Terms & Conditions and Risk Policy
 *   GET /brokers            brokers available for connection
 */
export const catalogRouter = Router();

catalogRouter.get('/segments', async (_req: Request, res: Response) => {
  const segments = await listActiveSegments();
  sendSuccess(res, { items: segments.map(serializeSegmentWithRules) });
});

catalogRouter.get('/policies/current', async (_req: Request, res: Response) => {
  const policies = await getCurrentPolicies();
  sendSuccess(res, { items: policies.map((doc) => serializePolicy(doc, { includeContent: true })) });
});

catalogRouter.get('/brokers', async (_req: Request, res: Response) => {
  const brokers = await listActiveBrokers();
  sendSuccess(res, { items: brokers.map(serializeBroker) });
});
