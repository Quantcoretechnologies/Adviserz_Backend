import { z } from 'zod';
import { toDecimal } from '../../common/utils/decimal.js';
import { decimalString, enumOf, pageParam, pageSizeParam } from '../../common/utils/validation.js';
import { emailSchema } from '../auth/auth.schemas.js';
import {
  AUDIT_ACTOR_TYPES,
  ONBOARDING_STATUSES,
  POLICY_STATUSES,
  POLICY_TYPES,
  RISK_BASES,
  USER_STATUSES,
} from '../../models/enums.js';

export const adminLoginBody = z.object({
  email: emailSchema,
  password: z
    .string({ error: 'Password is required' })
    .min(1, 'Password is required')
    .max(128, 'Password must be at most 128 characters'),
});

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export const listUsersQuery = z.object({
  page: pageParam,
  pageSize: pageSizeParam(100, 20),
  search: z
    .string()
    .trim()
    .min(1, 'Search must not be empty')
    .max(100, 'Search must be at most 100 characters')
    .optional(),
  status: enumOf(USER_STATUSES, 'Status').optional(),
  onboardingStatus: enumOf(ONBOARDING_STATUSES, 'Onboarding status').optional(),
  sortOrder: enumOf(['asc', 'desc'], 'Sort order').default('desc'),
});

export const blockUserBody = z.object({
  reason: z
    .string({ error: 'Reason is required' })
    .trim()
    .min(3, 'Reason must be at least 3 characters')
    .max(500, 'Reason must be at most 500 characters'),
});

// ---------------------------------------------------------------------------
// Segments
// ---------------------------------------------------------------------------

const money = decimalString(2, 'Minimum capital');
const percent = (label: string) =>
  decimalString(4, label).refine((value) => toDecimal(value).gt(0) && toDecimal(value).lte(100), {
    error: `${label} must be greater than 0 and at most 100`,
  });

const segmentName = z
  .string({ error: 'Name is required' })
  .trim()
  .min(2, 'Name must be at least 2 characters')
  .max(100, 'Name must be at most 100 characters');
const segmentDescription = z
  .string({ error: 'Description must be text' })
  .trim()
  .max(500, 'Description must be at most 500 characters')
  .nullable();
const isActive = z.boolean({ error: 'isActive must be true or false' });
const displayOrder = z
  .number({ error: 'Display order must be a number' })
  .int('Display order must be a whole number')
  .min(0, 'Display order must be at least 0')
  .max(10_000, 'Display order must be at most 10000');

export const createSegmentBody = z
  .object({
    code: z
      .string({ error: 'Code is required' })
      .trim()
      .transform((value) => value.toUpperCase())
      .pipe(z.string().regex(/^[A-Z][A-Z0-9_]{1,49}$/, 'Code must be 2-50 chars: A-Z, 0-9, "_", starting with a letter')),
    name: segmentName,
    description: segmentDescription.optional(),
    riskBasis: enumOf(RISK_BASES, 'Risk basis'),
    minCapital: money.default('0'),
    minRiskPercent: percent('Minimum risk percentage').default('0.01'),
    maxRiskPercent: percent('Maximum risk percentage').default('100'),
    currency: z
      .string({ error: 'Currency must be a 3-letter ISO code' })
      .trim()
      .regex(/^[A-Z]{3}$/, 'Currency must be a 3-letter ISO code')
      .default('INR'),
    isActive: isActive.default(true),
    displayOrder: displayOrder.default(0),
  })
  .refine((body) => toDecimal(body.minRiskPercent).lte(body.maxRiskPercent), {
    path: ['minRiskPercent'],
    message: 'Minimum risk percentage cannot exceed the maximum',
  });

/** code and riskBasis are immutable: changing them would rewrite the meaning of existing profiles. */
export const updateSegmentBody = z
  .object({
    name: segmentName.optional(),
    description: segmentDescription.optional(),
    minCapital: money.optional(),
    minRiskPercent: percent('Minimum risk percentage').optional(),
    maxRiskPercent: percent('Maximum risk percentage').optional(),
    isActive: isActive.optional(),
    displayOrder: displayOrder.optional(),
  })
  .refine((body) => Object.values(body).some((value) => value !== undefined), {
    message: 'Provide at least one field to update',
  });

// ---------------------------------------------------------------------------
// Policies
// ---------------------------------------------------------------------------

export const listPoliciesQuery = z.object({
  type: enumOf(POLICY_TYPES, 'Type').optional(),
  status: enumOf(POLICY_STATUSES, 'Status').optional(),
});

const policyTitle = z
  .string({ error: 'Title is required' })
  .trim()
  .min(3, 'Title must be at least 3 characters')
  .max(200, 'Title must be at most 200 characters');
const policyContent = z
  .string({ error: 'Content is required' })
  .trim()
  .min(1, 'Content is required')
  .max(200_000, 'Content must be at most 200000 characters');

export const createPolicyBody = z.object({
  type: enumOf(POLICY_TYPES, 'Type'),
  title: policyTitle,
  content: policyContent,
});

export const updatePolicyBody = z
  .object({
    title: policyTitle.optional(),
    content: policyContent.optional(),
  })
  .refine((body) => body.title !== undefined || body.content !== undefined, {
    message: 'Provide at least one field to update',
  });

// ---------------------------------------------------------------------------
// Stats & audit
// ---------------------------------------------------------------------------

export const statsQuery = z.object({
  days: z.coerce
    .number({ error: 'Days must be a number' })
    .int('Days must be a whole number')
    .min(1, 'Days must be at least 1')
    .max(365, 'Days must be at most 365')
    .default(30),
});

const dateParam = (label: string) => z.coerce.date({ error: `${label} must be a valid date` });

export const listAuditLogsQuery = z
  .object({
    page: pageParam,
    pageSize: pageSizeParam(200, 50),
    actorType: enumOf(AUDIT_ACTOR_TYPES, 'Actor type').optional(),
    actorId: z.uuid({ error: 'Actor id must be a valid id' }).optional(),
    subjectUserId: z.uuid({ error: 'Subject user id must be a valid id' }).optional(),
    action: z.string().trim().max(100, 'Action must be at most 100 characters').optional(),
    entityType: z.string().trim().max(50, 'Entity type must be at most 50 characters').optional(),
    entityId: z.string().trim().max(64, 'Entity id must be at most 64 characters').optional(),
    from: dateParam('"from"').optional(),
    to: dateParam('"to"').optional(),
  })
  .refine((query) => !query.from || !query.to || query.from <= query.to, {
    path: ['from'],
    message: '"from" must be before "to"',
  });
