import { z } from 'zod';
import { toDecimal } from '../../common/utils/decimal.js';
import { decimalString, enumOf, pageParam, pageSizeParam } from '../../common/utils/validation.js';
import { emailSchema, fullNameSchema, passwordSchema } from '../auth/auth.schemas.js';
import { isPermissionKey, type PermissionKey } from '../access/permissionCatalog.js';
import {
  ADMIN_STATUSES,
  AUDIT_ACTOR_TYPES,
  ONBOARDING_STATUSES,
  POLICY_STATUSES,
  POLICY_TYPES,
  RISK_BASES,
  SUGGESTED_RISK_MODES,
  USER_STATUSES,
} from '../../models/enums.js';

export const adminLoginBody = z.object({
  email: emailSchema,
  password: z
    .string({ error: 'Password is required' })
    .min(1, 'Password is required')
    .max(128, 'Password must be at most 128 characters'),
});

/** Staff passwords are longer than customer ones: at least 12 characters. */
const staffPassword = passwordSchema.and(z.string().min(12, 'Password must be at least 12 characters'));

export const changeAdminPasswordBody = z
  .object({
    currentPassword: z
      .string({ error: 'Current password is required' })
      .min(1, 'Current password is required')
      .max(128, 'Current password must be at most 128 characters'),
    newPassword: staffPassword,
    confirmPassword: z.string({ error: 'Confirm password is required' }),
  })
  .refine((body) => body.newPassword === body.confirmPassword, {
    path: ['confirmPassword'],
    message: 'Passwords do not match',
  });

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

const search = z
  .string()
  .trim()
  .min(1, 'Search must not be empty')
  .max(100, 'Search must be at most 100 characters');

/** Free text chosen by whoever creates the role. */
const roleName = z
  .string({ error: 'Role name is required' })
  .trim()
  .transform((value) => value.replace(/\s+/g, ' '))
  .pipe(
    z
      .string()
      .min(2, 'Role name must be at least 2 characters')
      .max(80, 'Role name must be at most 80 characters'),
  );

const roleDescription = z
  .string({ error: 'Description must be text' })
  .trim()
  .max(500, 'Description must be at most 500 characters')
  .transform((value) => (value === '' ? null : value))
  .nullable();

/** Explicit list of ticked permissions; duplicates are dropped. */
const rolePermissions = z
  .array(z.string({ error: 'Each permission must be text' }), { error: 'Permissions must be a list' })
  .min(1, 'Select at least one permission')
  .max(200, 'Too many permissions')
  .superRefine((keys, ctx) => {
    keys.forEach((key, index) => {
      if (!isPermissionKey(key)) ctx.addIssue({ code: 'custom', path: [index], message: `Unknown permission "${key}"` });
    });
  })
  .transform((keys) => [...new Set(keys)] as PermissionKey[]);

export const listRolesQuery = z.object({
  page: pageParam,
  pageSize: pageSizeParam(100, 20),
  search: search.optional(),
  ownerId: z.uuid({ error: 'Owner id must be a valid id' }).optional(),
  /** `true` lists only roles the caller created (the ones they can assign). */
  mine: enumOf(['true', 'false'], 'mine')
    .default('false')
    .transform((value) => value === 'true'),
});

/**
 * `?preview=true` runs the change and rolls it back, returning what it would
 * strip or delete. Used for the confirmation shown before a destructive action.
 */
export const previewQuery = z.object({
  preview: enumOf(['true', 'false'], 'preview')
    .default('false')
    .transform((value) => value === 'true'),
});

export const createRoleBody = z.object({
  name: roleName,
  description: roleDescription.optional(),
  permissions: rolePermissions,
});

export const updateRoleBody = z
  .object({
    name: roleName.optional(),
    description: roleDescription.optional(),
    permissions: rolePermissions.optional(),
  })
  .refine((body) => Object.values(body).some((value) => value !== undefined), {
    message: 'Provide at least one field to update',
  });

// ---------------------------------------------------------------------------
// Staff
// ---------------------------------------------------------------------------

const roleIds = z
  .array(z.uuid({ error: 'Each role id must be a valid id' }), { error: 'Role ids must be a list' })
  .max(50, 'Too many roles')
  .transform((ids) => [...new Set(ids)]);

export const listStaffQuery = z.object({
  page: pageParam,
  pageSize: pageSizeParam(100, 20),
  search: search.optional(),
  status: enumOf(ADMIN_STATUSES, 'Status').optional(),
  createdBy: z.uuid({ error: 'Created-by id must be a valid id' }).optional(),
  sortOrder: enumOf(['asc', 'desc'], 'Sort order').default('desc'),
});

export const createStaffBody = z.object({
  fullName: fullNameSchema,
  email: emailSchema,
  roleIds: roleIds.default([]),
  isSuperAdmin: z.boolean({ error: 'isSuperAdmin must be true or false' }).default(false),
});

export const updateStaffBody = z
  .object({
    fullName: fullNameSchema.optional(),
    email: emailSchema.optional(),
  })
  .refine((body) => body.fullName !== undefined || body.email !== undefined, {
    message: 'Provide at least one field to update',
  });

export const setStaffRolesBody = z.object({ roleIds });

export const blockStaffBody = z.object({
  reason: z
    .string({ error: 'Reason is required' })
    .trim()
    .min(3, 'Reason must be at least 3 characters')
    .max(500, 'Reason must be at most 500 characters'),
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
    /** The first (and only) band of version 1; add more bands through the band table. */
    minCapital: money.default('0'),
    minRiskPercent: percent('Minimum risk percentage').default('0.01'),
    maxRiskPercent: percent('Maximum risk percentage').default('100'),
    suggestedMode: enumOf(SUGGESTED_RISK_MODES, 'Suggested mode').default('manual'),
    suggestedRiskPercent: percent('Suggested risk percentage').optional(),
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

const LIMIT_FIELDS = ['minCapital', 'minRiskPercent', 'maxRiskPercent', 'suggestedRiskPercent', 'suggestedMode'] as const;

/**
 * code and riskBasis are immutable: changing them would rewrite the meaning of
 * existing profiles. Capital and risk limits are versioned bands, changed only
 * through PUT /admin/segments/:id/risk-rules (which notifies customers).
 */
export const updateSegmentBody = z
  .object({
    name: segmentName.optional(),
    description: segmentDescription.optional(),
    isActive: isActive.optional(),
    displayOrder: displayOrder.optional(),
  })
  .passthrough()
  .superRefine((body, ctx) => {
    for (const field of LIMIT_FIELDS) {
      if (field in body) {
        ctx.addIssue({
          code: 'custom',
          path: [field],
          message: 'Capital and risk limits are changed through the risk band table (PUT /admin/segments/:id/risk-rules)',
        });
      }
    }
  })
  .transform(({ name, description, isActive: active, displayOrder: order }) => ({
    name,
    description,
    isActive: active,
    displayOrder: order,
  }))
  .refine((body) => Object.values(body).some((value) => value !== undefined), {
    message: 'Provide at least one field to update',
  });

const bandPercent = (label: string) => decimalString(4, label);

/** The whole band table of a segment, lowest capital first. */
export const riskRulesBody = z.object({
  suggestedMode: enumOf(SUGGESTED_RISK_MODES, 'Suggested mode').optional(),
  bands: z
    .array(
      z.object({
        capitalFrom: decimalString(2, 'Capital from'),
        minRiskPercent: bandPercent('Minimum risk percentage'),
        maxRiskPercent: bandPercent('Maximum risk percentage'),
        suggestedRiskPercent: bandPercent('Suggested risk percentage').optional(),
      }),
      { error: 'Bands are required' },
    )
    .min(1, 'Add at least one band')
    .max(50, 'At most 50 bands'),
});

export const riskRuleVersionParams = z.object({
  id: z.uuid({ error: 'Invalid id' }),
  version: z.coerce
    .number({ error: 'Version must be a number' })
    .int('Version must be a whole number')
    .min(1, 'Version must be at least 1'),
});

export const riskRuleAcceptancesQuery = z.object({
  status: enumOf(['accepted', 'pending', 'up_to_date'], 'Status').optional(),
  page: pageParam,
  pageSize: pageSizeParam(100, 20),
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
