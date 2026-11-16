import { z } from 'zod';
import {
  capitalSchema,
  marketExperienceSchema,
  riskPercentSchema,
  uniqueSegmentIds,
} from '../riskProfile/riskProfile.domain.js';

const segmentId = z.uuid({ error: 'Invalid segment id' });

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
    .array(z.object({ segmentId, riskPercent: riskPercentSchema }))
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
