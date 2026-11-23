import { z } from 'zod';
import { emailSchema, otpCodeSchema, phoneSchema } from '../auth/auth.schemas.js';
import {
  capitalSchema,
  marketExperienceSchema,
  riskPercentSchema,
  uniqueSegmentIds,
} from '../riskProfile/riskProfile.domain.js';
import { acknowledgementSchema } from '../riskRules/riskAcknowledgement.service.js';

const segmentId = z.uuid({ error: 'Invalid segment id' });

/** Exactly one of `email` / `phone`: the contact the account is missing. */
export const contactOtpBody = z
  .object({ email: emailSchema.optional(), phone: phoneSchema.optional() })
  .refine((body) => (body.email === undefined) !== (body.phone === undefined), {
    message: 'Provide either an email address or a phone number',
  })
  .transform((body) => (body.email !== undefined ? { email: body.email } : { phone: body.phone as string }));

export const contactVerifyBody = z.object({
  verificationId: z.uuid({ error: 'Invalid verification id' }),
  otp: otpCodeSchema,
});

export const segmentsBody = z.object({
  segmentIds: z
    .array(segmentId, { error: 'Select at least one segment' })
    .min(1, 'Select at least one segment')
    .max(20, 'Too many segments selected')
    .refine((ids) => new Set(ids).size === ids.length, 'Duplicate segments are not allowed'),
});

export const experienceBody = z.object({ marketExperience: marketExperienceSchema });

export const capitalBody = z.object({
  allocations: z
    .array(z.object({ segmentId, capital: capitalSchema }))
    .min(1, 'Provide capital for each selected segment')
    .max(20, 'Too many segments selected')
    .refine(uniqueSegmentIds, 'Duplicate segments are not allowed'),
});

export const riskBody = z.object({
  allocations: z
    .array(
      z.object({
        segmentId,
        riskPercent: riskPercentSchema,
        /** Required when the risk is above the suggested level (see RISK_ACKNOWLEDGEMENT_REQUIRED). */
        acknowledgement: acknowledgementSchema.optional(),
      }),
    )
    .min(1, 'Provide risk for each selected segment')
    .max(20, 'Too many segments selected')
    .refine(uniqueSegmentIds, 'Duplicate segments are not allowed'),
});

export const acceptPoliciesBody = z.object({
  policyDocumentIds: z
    .array(z.uuid({ error: 'Invalid policy id' }), { error: 'Policy ids are required' })
    .min(1, 'Select the policies to accept')
    .max(10, 'Too many policies')
    .refine((ids) => new Set(ids).size === ids.length, 'Duplicate policy ids are not allowed'),
});
