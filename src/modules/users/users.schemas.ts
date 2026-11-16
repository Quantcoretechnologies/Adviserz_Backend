import { z } from 'zod';
import { fullNameSchema, passwordSchema, usernameSchema } from '../auth/auth.schemas.js';
import {
  capitalSchema,
  marketExperienceSchema,
  riskPercentSchema,
  uniqueSegmentIds,
} from '../riskProfile/riskProfile.domain.js';

export const updateProfileBody = z
  .object({
    fullName: fullNameSchema.optional(),
    username: usernameSchema.optional(),
  })
  .refine((body) => body.fullName !== undefined || body.username !== undefined, {
    message: 'Provide at least one field to update',
  });

export const changePasswordBody = z
  .object({
    currentPassword: z
      .string({ error: 'Current password is required' })
      .min(1, 'Current password is required')
      .max(128, 'Current password must be at most 128 characters'),
    newPassword: passwordSchema,
    confirmPassword: z.string({ error: 'Confirm password is required' }),
  })
  .refine((body) => body.newPassword === body.confirmPassword, {
    path: ['confirmPassword'],
    message: 'Passwords do not match',
  });

export const sessionIdParam = z.object({ sessionId: z.uuid({ error: 'Invalid session id' }) });

/** A complete replacement profile: every selected segment with capital and risk. */
export const updateRiskProfileBody = z.object({
  marketExperience: marketExperienceSchema,
  allocations: z
    .array(
      z.object({
        segmentId: z.uuid({ error: 'Invalid segment id' }),
        capital: capitalSchema,
        riskPercent: riskPercentSchema,
      }),
    )
    .min(1, 'Select at least one segment')
    .max(20, 'Too many segments selected')
    .refine(uniqueSegmentIds, 'Duplicate segments are not allowed'),
});

export const acceptPoliciesBody = z.object({
  policyDocumentIds: z
    .array(z.uuid({ error: 'Invalid policy id' }), { error: 'Policy ids are required' })
    .min(1, 'Select at least one policy to accept')
    .max(10, 'Too many policies')
    .refine((ids) => new Set(ids).size === ids.length, 'Duplicate policy ids are not allowed'),
});
