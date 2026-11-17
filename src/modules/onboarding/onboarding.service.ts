import { Op, type Transaction } from 'sequelize';
import { sequelize } from '../../db/sequelize.js';
import { AppError } from '../../common/errors/AppError.js';
import { ErrorCode } from '../../common/errors/errorCodes.js';
import type { RequestContext } from '../../common/http/requestContext.js';
import { formatMoney, formatPercent } from '../../common/utils/decimal.js';
import { RiskProfile, RiskProfileSegment, Segment, User } from '../../models/index.js';
import type { MarketExperience } from '../../models/enums.js';
import { recordAudit } from '../audit/audit.service.js';
import { AuditAction } from '../audit/auditActions.js';
import { assertEmailFree, assertPhoneFree } from '../auth/auth.service.js';
import { listActiveBrokers, serializeBroker } from '../brokers/broker.service.js';
import {
  acceptPolicies,
  assertPoliciesAccepted,
  getCurrentPolicies,
  getPendingPolicies,
  serializePolicy,
} from '../policies/policy.service.js';
import {
  assertExactSegmentSet,
  capitalViolation,
  findProfile,
  riskViolation,
  serializeRiskProfile,
  throwIfViolations,
} from '../riskProfile/riskProfile.domain.js';
import { listActiveSegments, loadSelectableSegments, serializeSegment } from '../segments/segment.service.js';
import { serializeUser } from '../users/user.serializer.js';
import { consumeVerificationToken, issueOtp, verifyOtp } from '../verification/verification.service.js';

/**
 * Onboarding = verifying the user's second contact, then building their first
 * risk profile as a `draft`, one step at a time, and confirming it
 * (draft -> active). Steps:
 *
 *   contact -> segments -> experience -> capital -> risk -> broker (optional) -> policies -> confirm
 *
 * `contact`: an account is created from one verified contact (phone or
 * email); the other one is verified here. Accounts that registered with both
 * already have this step done.
 *
 * Every mutation locks the user row, so concurrent requests from web and
 * mobile apply one after another and never interleave.
 */
export const ONBOARDING_STEPS = ['contact', 'segments', 'experience', 'capital', 'risk', 'broker', 'policies'] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number] | 'confirm';

interface StepStatus {
  contact: boolean;
  segments: boolean;
  experience: boolean;
  capital: boolean;
  risk: boolean;
  broker: boolean;
  policies: boolean;
}

/** The contact the user still has to verify, if any. */
function missingContact(user: User): 'email' | 'phone' | null {
  if (user.email === null) return 'email';
  if (user.phone === null) return 'phone';
  return null;
}

function computeSteps(
  user: User,
  draft: RiskProfile | null,
  rows: RiskProfileSegment[],
  pendingPolicies: number,
): StepStatus {
  const hasSegments = rows.length > 0;
  return {
    contact: missingContact(user) === null,
    segments: hasSegments,
    experience: draft?.marketExperience != null,
    capital: hasSegments && rows.every((row) => row.capital !== null),
    risk: hasSegments && rows.every((row) => row.riskPercent !== null),
    broker: draft?.brokerStepStatus != null,
    policies: pendingPolicies === 0,
  };
}

function nextStep(steps: StepStatus): OnboardingStep {
  return ONBOARDING_STEPS.find((step) => !steps[step]) ?? 'confirm';
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** Full onboarding state for the client to render the current step. */
export async function getOnboardingState(userId: string) {
  const user = await User.findByPk(userId);
  if (!user) throw AppError.unauthorized();

  if (user.onboardingStatus === 'completed') {
    return {
      status: 'completed' as const,
      completedAt: user.onboardingCompletedAt,
      nextStep: null,
      steps: null,
      draft: null,
      availableSegments: [],
      brokers: [],
      policies: [],
    };
  }

  const [draft, segments, brokers, currentPolicies, pendingPolicies] = await Promise.all([
    findProfile({ userId, status: 'draft' }),
    listActiveSegments(),
    listActiveBrokers(),
    getCurrentPolicies(),
    getPendingPolicies(userId),
  ]);

  const steps = computeSteps(user, draft, draft?.segments ?? [], pendingPolicies.length);
  const pendingIds = new Set(pendingPolicies.map((doc) => doc.id));

  return {
    status: 'pending' as const,
    completedAt: null,
    nextStep: nextStep(steps),
    steps: {
      ...steps,
      missingContact: missingContact(user),
      brokerStepStatus: draft?.brokerStepStatus ?? null,
      brokerIntegrationAvailable: brokers.length > 0,
    },
    draft: draft ? serializeRiskProfile(draft) : null,
    availableSegments: segments.map(serializeSegment),
    brokers: brokers.map(serializeBroker),
    policies: currentPolicies.map((doc) => ({
      ...serializePolicy(doc, { includeContent: true }),
      accepted: !pendingIds.has(doc.id),
    })),
  };
}

// ---------------------------------------------------------------------------
// Draft helpers
// ---------------------------------------------------------------------------

interface DraftScope {
  user: User;
  draft: RiskProfile;
  rows: RiskProfileSegment[];
  transaction: Transaction;
}

/**
 * Run `fn` in a transaction holding the user row lock and the (lazily
 * created) onboarding draft. Rejects once onboarding is complete.
 */
async function withDraft<T>(userId: string, fn: (scope: DraftScope) => Promise<T>): Promise<T> {
  return sequelize.transaction(async (transaction) => {
    const user = await User.findByPk(userId, { lock: transaction.LOCK.UPDATE, transaction });
    if (!user) throw AppError.unauthorized();
    if (user.onboardingStatus === 'completed') {
      throw AppError.conflict('Onboarding is already completed', ErrorCode.ONBOARDING_ALREADY_COMPLETED);
    }

    let draft = await RiskProfile.findOne({ where: { userId, status: 'draft' }, transaction });
    if (!draft) {
      const maxVersion = (await RiskProfile.max<number | null, RiskProfile>('version', {
        where: { userId },
        transaction,
      })) as number | null;
      draft = await RiskProfile.create(
        { userId, version: (maxVersion ?? 0) + 1, status: 'draft', source: 'onboarding' },
        { transaction },
      );
    }

    const rows = await RiskProfileSegment.findAll({
      where: { riskProfileId: draft.id },
      order: [['createdAt', 'ASC']],
      transaction,
    });

    return fn({ user, draft, rows, transaction });
  });
}

function requireSegmentsSelected(rows: RiskProfileSegment[]): void {
  if (rows.length === 0) {
    throw AppError.unprocessable('Select your trading segments first', ErrorCode.ONBOARDING_STEP_PREREQUISITE, [
      { path: 'segments', message: 'No segments selected' },
    ]);
  }
}

async function segmentCodes(ids: string[], transaction: Transaction): Promise<string[]> {
  if (ids.length === 0) return [];
  const segments = await Segment.findAll({ where: { id: { [Op.in]: ids } }, attributes: ['code'], transaction });
  return segments.map((segment) => segment.code).sort();
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

export type ContactInput = { email: string } | { phone: string };

/** Load a user who may still add `kind`; rejects once it is set or onboarding is done. */
async function loadUserMissing(userId: string, kind: 'email' | 'phone', transaction?: Transaction): Promise<User> {
  const user = await User.findByPk(userId, transaction ? { lock: transaction.LOCK.UPDATE, transaction } : {});
  if (!user) throw AppError.unauthorized();
  if (user.onboardingStatus === 'completed') {
    throw AppError.conflict('Onboarding is already completed', ErrorCode.ONBOARDING_ALREADY_COMPLETED);
  }
  if (user[kind] !== null) {
    const label = kind === 'email' ? 'An email address' : 'A phone number';
    throw AppError.conflict(`${label} is already verified for this account`, ErrorCode.CONFLICT, [
      { path: kind, message: 'Already verified' },
    ]);
  }
  return user;
}

/**
 * Contact step, part 1: send a code to the contact the account is missing
 * (email for a phone signup, phone for an email signup).
 */
export async function sendContactOtp(userId: string, contact: ContactInput, context: RequestContext) {
  if ('email' in contact) {
    await loadUserMissing(userId, 'email');
    await assertEmailFree(contact.email);
    return issueOtp({ purpose: 'contact_verification', channel: 'email', destination: contact.email, userId, context });
  }
  await loadUserMissing(userId, 'phone');
  await assertPhoneFree(contact.phone);
  return issueOtp({ purpose: 'contact_verification', channel: 'sms', destination: contact.phone, userId, context });
}

/**
 * Contact step, part 2: check the code and attach the contact to the account.
 * The code must have been requested by this same user, and the contact is
 * re-checked for uniqueness inside the transaction that stores it.
 */
export async function verifyContactOtp(userId: string, verificationId: string, otp: string, context: RequestContext) {
  const verified = await verifyOtp({ verificationId, code: otp, purpose: 'contact_verification', context, userId });
  const kind = verified.channel === 'email' ? 'email' : 'phone';
  const invalid = AppError.badRequest('The verification code is invalid', ErrorCode.OTP_INVALID);

  await sequelize.transaction(async (transaction) => {
    const user = await loadUserMissing(userId, kind, transaction);
    const verification = await consumeVerificationToken(
      {
        token: verified.verificationToken,
        purpose: 'contact_verification',
        channel: verified.channel,
        destination: verified.destination,
        invalidError: invalid,
      },
      transaction,
    );
    if (verification.userId !== userId) throw invalid;

    const verifiedAt = verification.verifiedAt ?? new Date();
    if (kind === 'email') {
      await assertEmailFree(verification.destination, transaction);
      user.email = verification.destination;
      user.emailVerifiedAt = verifiedAt;
    } else {
      await assertPhoneFree(verification.destination, transaction);
      user.phone = verification.destination;
      user.phoneVerifiedAt = verifiedAt;
    }
    await user.save({ transaction });

    await recordAudit(
      {
        actor: { type: 'user', id: userId },
        action: AuditAction.ONBOARDING_CONTACT_VERIFIED,
        entityType: 'user',
        entityId: userId,
        subjectUserId: userId,
        before: { [kind]: null },
        after: { [kind]: verification.destination },
        context,
      },
      transaction,
    );
  });
  return getOnboardingState(userId);
}

/**
 * Replace the selected segments. Values already entered for segments that
 * remain selected are kept; removed segments drop their values.
 */
export async function saveSegments(userId: string, segmentIds: string[], context: RequestContext) {
  await withDraft(userId, async ({ draft, rows, transaction }) => {
    const segments = await loadSelectableSegments(segmentIds, transaction);
    const before = rows.map((row) => row.segmentId);
    const keep = new Set(segmentIds);

    await RiskProfileSegment.destroy({
      where: { riskProfileId: draft.id, segmentId: { [Op.notIn]: segmentIds } },
      transaction,
    });

    const existing = new Set(before);
    const toAdd = segmentIds.filter((id) => !existing.has(id));
    if (toAdd.length > 0) {
      await RiskProfileSegment.bulkCreate(
        toAdd.map((segmentId) => {
          const segment = segments.get(segmentId);
          if (!segment) throw new Error(`Segment ${segmentId} not loaded`);
          return { riskProfileId: draft.id, segmentId, riskBasis: segment.riskBasis, currency: segment.currency };
        }),
        { transaction },
      );
    }

    await recordAudit(
      {
        actor: { type: 'user', id: userId },
        action: AuditAction.ONBOARDING_SEGMENTS_SAVED,
        entityType: 'risk_profile',
        entityId: draft.id,
        subjectUserId: userId,
        before: { segments: await segmentCodes(before, transaction) },
        after: { segments: await segmentCodes([...keep], transaction) },
        context,
      },
      transaction,
    );
  });
  return getOnboardingState(userId);
}

export async function saveExperience(userId: string, marketExperience: MarketExperience, context: RequestContext) {
  await withDraft(userId, async ({ draft, transaction }) => {
    const before = draft.marketExperience;
    draft.marketExperience = marketExperience;
    await draft.save({ transaction });

    await recordAudit(
      {
        actor: { type: 'user', id: userId },
        action: AuditAction.ONBOARDING_EXPERIENCE_SAVED,
        entityType: 'risk_profile',
        entityId: draft.id,
        subjectUserId: userId,
        before: { marketExperience: before },
        after: { marketExperience },
        context,
      },
      transaction,
    );
  });
  return getOnboardingState(userId);
}

export async function saveCapital(
  userId: string,
  allocations: { segmentId: string; capital: string }[],
  context: RequestContext,
) {
  await withDraft(userId, async ({ draft, rows, transaction }) => {
    requireSegmentsSelected(rows);
    assertExactSegmentSet(
      rows.map((row) => row.segmentId),
      allocations.map((item) => item.segmentId),
    );

    const segments = await loadSelectableSegments(rows.map((row) => row.segmentId), transaction);
    throwIfViolations(
      allocations.map((item) => {
        const segment = segments.get(item.segmentId);
        return segment ? capitalViolation(segment, item.capital) : null;
      }),
      ErrorCode.CAPITAL_BELOW_MINIMUM,
      'Capital is below the minimum for one or more segments',
    );

    const before: Record<string, string | null> = {};
    const after: Record<string, string> = {};
    for (const item of allocations) {
      const row = rows.find((candidate) => candidate.segmentId === item.segmentId);
      const segment = segments.get(item.segmentId);
      if (!row || !segment) continue;
      before[segment.code] = row.capital;
      row.capital = formatMoney(item.capital);
      row.currency = segment.currency;
      after[segment.code] = row.capital;
      await row.save({ transaction });
    }

    await recordAudit(
      {
        actor: { type: 'user', id: userId },
        action: AuditAction.ONBOARDING_CAPITAL_SAVED,
        entityType: 'risk_profile',
        entityId: draft.id,
        subjectUserId: userId,
        before: { capital: before },
        after: { capital: after },
        context,
      },
      transaction,
    );
  });
  return getOnboardingState(userId);
}

export async function saveRisk(
  userId: string,
  allocations: { segmentId: string; riskPercent: string }[],
  context: RequestContext,
) {
  await withDraft(userId, async ({ draft, rows, transaction }) => {
    requireSegmentsSelected(rows);
    assertExactSegmentSet(
      rows.map((row) => row.segmentId),
      allocations.map((item) => item.segmentId),
    );

    const segments = await loadSelectableSegments(rows.map((row) => row.segmentId), transaction);
    throwIfViolations(
      allocations.map((item) => {
        const segment = segments.get(item.segmentId);
        return segment ? riskViolation(segment, item.riskPercent) : null;
      }),
      ErrorCode.RISK_OUT_OF_RANGE,
      'Risk is outside the allowed range for one or more segments',
    );

    const before: Record<string, string | null> = {};
    const after: Record<string, string> = {};
    for (const item of allocations) {
      const row = rows.find((candidate) => candidate.segmentId === item.segmentId);
      const segment = segments.get(item.segmentId);
      if (!row || !segment) continue;
      before[segment.code] = row.riskPercent;
      row.riskPercent = formatPercent(item.riskPercent);
      row.riskBasis = segment.riskBasis;
      after[segment.code] = row.riskPercent;
      await row.save({ transaction });
    }

    await recordAudit(
      {
        actor: { type: 'user', id: userId },
        action: AuditAction.ONBOARDING_RISK_SAVED,
        entityType: 'risk_profile',
        entityId: draft.id,
        subjectUserId: userId,
        before: { riskPercent: before },
        after: { riskPercent: after },
        context,
      },
      transaction,
    );
  });
  return getOnboardingState(userId);
}

/** The broker step is optional; skipping is recorded explicitly. */
export async function skipBrokerStep(userId: string, context: RequestContext) {
  await withDraft(userId, async ({ draft, transaction }) => {
    if (draft.brokerStepStatus === 'skipped') return;
    const before = draft.brokerStepStatus;
    draft.brokerStepStatus = 'skipped';
    await draft.save({ transaction });

    await recordAudit(
      {
        actor: { type: 'user', id: userId },
        action: AuditAction.ONBOARDING_BROKER_SKIPPED,
        entityType: 'risk_profile',
        entityId: draft.id,
        subjectUserId: userId,
        before: { brokerStepStatus: before },
        after: { brokerStepStatus: 'skipped' },
        context,
      },
      transaction,
    );
  });
  return getOnboardingState(userId);
}

export async function acceptOnboardingPolicies(userId: string, policyDocumentIds: string[], context: RequestContext) {
  await withDraft(userId, async ({ transaction }) => {
    await acceptPolicies({ userId, policyDocumentIds, context }, transaction);
  });
  return getOnboardingState(userId);
}

/**
 * Confirm onboarding. Every rule is re-checked against the CURRENT segment
 * configuration (an admin may have changed limits since a step was saved),
 * then the draft becomes the active profile and the user is marked onboarded
 * — atomically.
 */
export async function confirmOnboarding(userId: string, context: RequestContext) {
  const profileId = await withDraft(userId, async ({ user, draft, rows, transaction }) => {
    const pending = await getPendingPolicies(userId, transaction);
    const steps = computeSteps(user, draft, rows, pending.length);
    const incomplete = ONBOARDING_STEPS.filter((step) => !steps[step]);
    if (incomplete.length > 0) {
      throw AppError.unprocessable(
        'Please complete all onboarding steps before confirming',
        ErrorCode.ONBOARDING_INCOMPLETE,
        incomplete.map((step) => ({ path: step, message: 'Step not completed', step })),
      );
    }

    const segments = await loadSelectableSegments(rows.map((row) => row.segmentId), transaction);
    throwIfViolations(
      rows.map((row) => {
        const segment = segments.get(row.segmentId);
        return segment && row.capital ? capitalViolation(segment, row.capital) : null;
      }),
      ErrorCode.CAPITAL_BELOW_MINIMUM,
      'Capital is below the current minimum for one or more segments',
    );
    throwIfViolations(
      rows.map((row) => {
        const segment = segments.get(row.segmentId);
        return segment && row.riskPercent ? riskViolation(segment, row.riskPercent) : null;
      }),
      ErrorCode.RISK_OUT_OF_RANGE,
      'Risk is outside the current allowed range for one or more segments',
    );
    await assertPoliciesAccepted(userId, transaction);

    const now = new Date();
    draft.status = 'active';
    draft.confirmedAt = now;
    await draft.save({ transaction });

    user.onboardingStatus = 'completed';
    user.onboardingCompletedAt = now;
    await user.save({ transaction });

    const confirmed = await findProfile({ id: draft.id }, transaction);
    await recordAudit(
      {
        actor: { type: 'user', id: userId },
        action: AuditAction.ONBOARDING_COMPLETED,
        entityType: 'risk_profile',
        entityId: draft.id,
        subjectUserId: userId,
        after: confirmed ? serializeRiskProfile(confirmed) : { id: draft.id },
        context,
      },
      transaction,
    );

    return draft.id;
  });

  const [user, profile] = await Promise.all([User.findByPk(userId), findProfile({ id: profileId })]);
  if (!user || !profile) throw new Error('Confirmed onboarding could not be reloaded');
  return { user: serializeUser(user), riskProfile: serializeRiskProfile(profile) };
}
