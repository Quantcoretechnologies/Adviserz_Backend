import type { Request, Response } from 'express';
import { requireUserAuth } from '../../common/middleware/authenticate.js';
import { getRequestContext } from '../../common/http/requestContext.js';
import { sendSuccess } from '../../common/http/response.js';
import { parseInput } from '../../common/utils/validation.js';
import * as service from './onboarding.service.js';
import {
  acceptPoliciesBody,
  capitalBody,
  contactOtpBody,
  contactVerifyBody,
  experienceBody,
  riskBody,
  segmentsBody,
} from './onboarding.schemas.js';

export async function getState(req: Request, res: Response): Promise<void> {
  const { userId } = requireUserAuth(req);
  sendSuccess(res, await service.getOnboardingState(userId));
}

export async function sendContactOtp(req: Request, res: Response): Promise<void> {
  const { userId } = requireUserAuth(req);
  const contact = parseInput(contactOtpBody, req.body);
  sendSuccess(res, await service.sendContactOtp(userId, contact, getRequestContext(req)), 'Verification code sent');
}

export async function verifyContact(req: Request, res: Response): Promise<void> {
  const { userId } = requireUserAuth(req);
  const { verificationId, otp } = parseInput(contactVerifyBody, req.body);
  sendSuccess(
    res,
    await service.verifyContactOtp(userId, verificationId, otp, getRequestContext(req)),
    'Verified successfully',
  );
}

export async function saveSegments(req: Request, res: Response): Promise<void> {
  const { userId } = requireUserAuth(req);
  const { segmentIds } = parseInput(segmentsBody, req.body);
  sendSuccess(res, await service.saveSegments(userId, segmentIds, getRequestContext(req)), 'Segments saved');
}

export async function saveExperience(req: Request, res: Response): Promise<void> {
  const { userId } = requireUserAuth(req);
  const { marketExperience } = parseInput(experienceBody, req.body);
  sendSuccess(res, await service.saveExperience(userId, marketExperience, getRequestContext(req)), 'Experience saved');
}

export async function saveCapital(req: Request, res: Response): Promise<void> {
  const { userId } = requireUserAuth(req);
  const { allocations } = parseInput(capitalBody, req.body);
  sendSuccess(res, await service.saveCapital(userId, allocations, getRequestContext(req)), 'Capital saved');
}

export async function saveRisk(req: Request, res: Response): Promise<void> {
  const { userId } = requireUserAuth(req);
  const { allocations } = parseInput(riskBody, req.body);
  sendSuccess(res, await service.saveRisk(userId, allocations, getRequestContext(req)), 'Risk saved');
}

export async function skipBroker(req: Request, res: Response): Promise<void> {
  const { userId } = requireUserAuth(req);
  sendSuccess(res, await service.skipBrokerStep(userId, getRequestContext(req)), 'Broker step skipped');
}

export async function acceptPolicies(req: Request, res: Response): Promise<void> {
  const { userId } = requireUserAuth(req);
  const { policyDocumentIds } = parseInput(acceptPoliciesBody, req.body);
  sendSuccess(
    res,
    await service.acceptOnboardingPolicies(userId, policyDocumentIds, getRequestContext(req)),
    'Policies accepted',
  );
}

export async function confirm(req: Request, res: Response): Promise<void> {
  const { userId } = requireUserAuth(req);
  sendSuccess(res, await service.confirmOnboarding(userId, getRequestContext(req)), 'Onboarding completed');
}
