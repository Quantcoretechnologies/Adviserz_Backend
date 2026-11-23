import { z } from 'zod';
import { capitalSchema, riskPercentSchema, uniqueSegmentIds } from '../riskProfile/riskProfile.domain.js';
import { loadSelectableSegments } from '../segments/segment.service.js';
import { assess, buildDisclaimer, serializeAssessment, serializeDisclaimer } from './riskAcknowledgement.service.js';
import { capitalViolation, riskViolation } from './riskRules.domain.js';

export const riskAssessmentBody = z.object({
  allocations: z
    .array(
      z.object({
        segmentId: z.uuid({ error: 'Invalid segment id' }),
        capital: capitalSchema,
        riskPercent: riskPercentSchema,
      }),
    )
    .min(1, 'Provide at least one segment')
    .max(20, 'Too many segments')
    .refine(uniqueSegmentIds, 'Duplicate segments are not allowed'),
});

/**
 * Check values against the bands in force WITHOUT saving anything: the band,
 * whether the values are allowed, and — when a disclaimer is needed — its
 * text filled in with these values plus the fingerprint to send back with the
 * acknowledgement. Used by the apps before saving onboarding, a profile edit
 * or a change notice with new values.
 */
export async function assessRisk(input: z.output<typeof riskAssessmentBody>) {
  const segments = await loadSelectableSegments(input.allocations.map((item) => item.segmentId));
  const items = [];
  for (const item of input.allocations) {
    const loaded = segments.get(item.segmentId);
    if (!loaded) continue;
    const { segment, rules } = loaded;
    const violation =
      capitalViolation(segment, rules, item.capital) ?? riskViolation(segment, rules, item.capital, item.riskPercent);
    const assessment = assess(segment, rules, item.capital, item.riskPercent);
    const allowed = violation === null && assessment !== null;
    items.push({
      segmentId: segment.id,
      allowed,
      violation,
      assessment: assessment ? serializeAssessment(assessment) : null,
      disclaimer:
        allowed && assessment?.required ? serializeDisclaimer(await buildDisclaimer(assessment)) : null,
    });
  }
  return { items };
}
