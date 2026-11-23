import { Op, type Transaction } from 'sequelize';
import { sequelize } from '../../db/sequelize.js';
import { AppError } from '../../common/errors/AppError.js';
import { ErrorCode } from '../../common/errors/errorCodes.js';
import type { RequestContext } from '../../common/http/requestContext.js';
import { formatMoney, formatPercent, toDecimal } from '../../common/utils/decimal.js';
import { RiskAcknowledgement, RiskProfile, RiskProfileSegment, Segment, User } from '../../models/index.js';
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
  findProfile,
  serializeRiskProfile,
  throwIfViolations,
} from '../riskProfile/riskProfile.domain.js';
import {
  acknowledgementCovers,
  assess,
  loadAcknowledgements,
  recordAcknowledgements,
  settleChoices,
  type AcknowledgementInput,
  type Assessment,
} from '../riskRules/riskAcknowledgement.service.js';
import {
  capitalViolation,
  loadCurrentRules,
  riskViolation,
  type CurrentRules,
} from '../riskRules/riskRules.domain.js';
import {
  listActiveSegments,
  loadSelectableSegments,
  serializeSegmentWithRules,
  type SegmentWithRules,
} from '../segments/segment.service.js';
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
 * Capital and risk are checked against each segment's capital bands IN FORCE
 * NOW, every time the state is read: if an admin changes the bands, or the
 * user changes their capital after choosing a risk, the step is open again
 * until the values fit (and any disclaimer they need is accepted).
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

/** How one selected segment's values stand under the current bands. */
interface RowCheck {
  segmentId: string;
  capitalOk: boolean;
  riskOk: boolean;
  /** Present once capital and risk are both filled in and the capital fits a band. */
  assessment: Assessment | null;
  acknowledged: boolean;
}

/** The contact the user still has to verify, if any. */
function missingContact(user: User): 'email' | 'phone' | null {
  if (user.email === null) return 'email';
  if (user.phone === null) return 'phone';
  return null;
}

/** Check each draft row's capital and risk against the bands in force. */
async function checkRows(rows: RiskProfileSegment[], transaction?: Transaction): Promise<RowCheck[]> {
  if (rows.length === 0) return [];
  const [segments, rules, acks] = await Promise.all([
    Segment.findAll({ where: { id: { [Op.in]: rows.map((row) => row.segmentId) } }, transaction }),
    loadCurrentRules(
      rows.map((row) => row.segmentId),
      transaction,
    ),
    loadAcknowledgements(
      rows.map((row) => row.riskAcknowledgementId),
      transaction,
    ),
  ]);
  const segmentById = new Map(segments.map((segment) => [segment.id, segment]));

  return rows.map((row) => {
    const segment = segmentById.get(row.segmentId);
    const current = rules.get(row.segmentId);
    const none = { segmentId: row.segmentId, capitalOk: false, riskOk: false, assessment: null, acknowledged: false };
    if (!segment || !current || row.capital === null) return none;

    const capitalOk = capitalViolation(segment, current, row.capital) === null;
    if (!capitalOk || row.riskPercent === null) return { ...none, capitalOk };

    const assessment = assess(segment, current, row.capital, row.riskPercent);
    if (!assessment) return { ...none, capitalOk };
    const blocked = assessment.level === 'below_minimum' || assessment.level === 'above_ceiling';
    const acknowledged = assessment.required === null || acknowledgementCovers(acks.get(row.riskAcknowledgementId ?? ''), assessment);
    return { segmentId: row.segmentId, capitalOk, riskOk: !blocked && acknowledged, assessment, acknowledged };
  });
}

function computeSteps(
  user: User,
  draft: RiskProfile | null,
  rows: RiskProfileSegment[],
  checks: RowCheck[],
  pendingPolicies: number,
): StepStatus {
  const hasSegments = rows.length > 0;
  return {
    contact: missingContact(user) === null,
    segments: hasSegments,
    experience: draft?.marketExperience != null,
    capital: hasSegments && checks.every((check) => check.capitalOk),
    risk: hasSegments && checks.every((check) => check.riskOk),
    broker: draft?.brokerStepStatus != null,
    policies: pendingPolicies === 0,
  };
}

function nextStep(steps: StepStatus): OnboardingStep {
  return ONBOARDING_STEPS.find((step) => !steps[step]) ?? 'confirm';
}

function serializeRowCheck(check: RowCheck) {
  const { assessment } = check;
  return {
    segmentId: check.segmentId,
    capitalOk: check.capitalOk,
    riskOk: check.riskOk,
    level: assessment?.level ?? null,
    acknowledgementRequired: assessment?.required ?? null,
    acknowledged: check.acknowledged,
    riskAmount: assessment?.riskAmount ?? null,
  };
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
      segmentChecks: [],
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

  const rows = draft?.segments ?? [];
  const checks = await checkRows(rows);
  const steps = computeSteps(user, draft, rows, checks, pendingPolicies.length);
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
    /** Per selected segment: do capital and risk fit the bands in force, and is any needed disclaimer accepted. */
    segmentChecks: checks.map(serializeRowCheck),
    availableSegments: segments.map(serializeSegmentWithRules),
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
      where: { riskProfileId: draft.id, isDeleted: false },
      include: [{ model: Segment, as: 'segment', attributes: [] }],
      // The segment list's own order (rows saved together share a timestamp).
      order: [
        [{ model: Segment, as: 'segment' }, 'displayOrder', 'ASC'],
        [{ model: Segment, as: 'segment' }, 'name', 'ASC'],
      ],
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

function getLoaded(segments: Map<string, SegmentWithRules>, segmentId: string): SegmentWithRules {
  const loaded = segments.get(segmentId);
  if (!loaded) throw new Error(`Segment ${segmentId} not loaded`);
  return loaded;
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
 * remain selected are kept. A removed segment's row is marked deleted (never
 * hard-deleted), so the values the user had entered stay on record; selecting
 * the segment again starts a fresh row.
 */
export async function saveSegments(userId: string, segmentIds: string[], context: RequestContext) {
  await withDraft(userId, async ({ draft, rows, transaction }) => {
    const segments = await loadSelectableSegments(segmentIds, transaction);
    const before = rows.map((row) => row.segmentId);
    const keep = new Set(segmentIds);
    const removed = rows.filter((row) => !keep.has(row.segmentId));

    if (removed.length > 0) {
      await RiskProfileSegment.update(
        { isDeleted: true, deletedAt: new Date() },
        { where: { id: { [Op.in]: removed.map((row) => row.id) }, isDeleted: false }, transaction },
      );
    }

    const existing = new Set(before);
    const toAdd = segmentIds.filter((id) => !existing.has(id));
    if (toAdd.length > 0) {
      await RiskProfileSegment.bulkCreate(
        toAdd.map((segmentId) => {
          const { segment } = getLoaded(segments, segmentId);
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

/**
 * Save capital per segment. A changed capital may move the user into another
 * band, so any disclaimer accepted for the old capital no longer counts; the
 * risk already entered is kept and re-checked at the risk step.
 */
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

    const segments = await loadSelectableSegments(
      rows.map((row) => row.segmentId),
      transaction,
    );
    throwIfViolations(
      allocations.map((item) => {
        const { segment, rules } = getLoaded(segments, item.segmentId);
        return capitalViolation(segment, rules, item.capital);
      }),
      ErrorCode.CAPITAL_BELOW_MINIMUM,
      'Capital is below the minimum for one or more segments',
    );

    const before: Record<string, string | null> = {};
    const after: Record<string, string> = {};
    for (const item of allocations) {
      const row = rows.find((candidate) => candidate.segmentId === item.segmentId);
      const { segment } = getLoaded(segments, item.segmentId);
      if (!row) continue;
      before[segment.code] = row.capital;
      const changed = row.capital === null || !toDecimal(row.capital).eq(item.capital);
      row.capital = formatMoney(item.capital);
      row.currency = segment.currency;
      if (changed) row.riskAcknowledgementId = null;
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

/**
 * What each segment held before this risk save, for the acknowledgement log:
 * the risk last saved, with the capital it was saved against. A capital change
 * unlinks the row from its acknowledgement and overwrites the capital, so when
 * the newest acknowledgement for the segment is for that same risk, its
 * capital is the one the risk was chosen with. Nothing saved yet -> no values.
 */
async function previousChoices(
  userId: string,
  riskProfileId: string,
  rows: RiskProfileSegment[],
  transaction: Transaction,
): Promise<Map<string, { capital: string | null; riskPercent: string }>> {
  const acks = await RiskAcknowledgement.findAll({
    where: { userId, riskProfileId, segmentId: { [Op.in]: rows.map((row) => row.segmentId) } },
    order: [['createdAt', 'DESC']],
    transaction,
  });
  const previous = new Map<string, { capital: string | null; riskPercent: string }>();
  for (const row of rows) {
    if (row.riskPercent === null) continue;
    const latest = acks.find((ack) => ack.segmentId === row.segmentId);
    const sameRisk = latest && toDecimal(latest.riskPercent).equals(toDecimal(row.riskPercent));
    previous.set(row.segmentId, { capital: sameRisk ? latest.capital : row.capital, riskPercent: row.riskPercent });
  }
  return previous;
}

/**
 * Save risk per segment, checked against the band for the capital already
 * saved. Below the band minimum or above 100% is rejected; above the suggested
 * or maximum level needs the matching disclaimer accepted in the same request
 * (unless one already on record covers the very same values).
 */
export async function saveRisk(
  userId: string,
  allocations: { segmentId: string; riskPercent: string; acknowledgement?: AcknowledgementInput | undefined }[],
  context: RequestContext,
) {
  await withDraft(userId, async ({ draft, rows, transaction }) => {
    requireSegmentsSelected(rows);
    assertExactSegmentSet(
      rows.map((row) => row.segmentId),
      allocations.map((item) => item.segmentId),
    );
    const withoutCapital = rows.filter((row) => row.capital === null);
    if (withoutCapital.length > 0) {
      throw AppError.unprocessable('Enter your capital first', ErrorCode.ONBOARDING_STEP_PREREQUISITE, [
        ...withoutCapital.map((row) => ({ path: 'capital', message: 'Capital not entered', segmentId: row.segmentId })),
      ]);
    }

    const segments = await loadSelectableSegments(
      rows.map((row) => row.segmentId),
      transaction,
    );
    const rowFor = (segmentId: string): RiskProfileSegment => {
      const row = rows.find((candidate) => candidate.segmentId === segmentId);
      if (!row?.capital) throw new Error(`Draft row for ${segmentId} not loaded`);
      return row;
    };

    // Capital may have become too low since it was saved (an admin raised the minimum).
    throwIfViolations(
      allocations.map((item) => {
        const { segment, rules } = getLoaded(segments, item.segmentId);
        return capitalViolation(segment, rules, rowFor(item.segmentId).capital ?? '0');
      }),
      ErrorCode.CAPITAL_BELOW_MINIMUM,
      'Capital is below the current minimum for one or more segments',
    );
    throwIfViolations(
      allocations.map((item) => {
        const { segment, rules } = getLoaded(segments, item.segmentId);
        return riskViolation(segment, rules, rowFor(item.segmentId).capital ?? '0', item.riskPercent);
      }),
      ErrorCode.RISK_OUT_OF_RANGE,
      'Risk is outside the allowed range for one or more segments',
    );

    const existingAcks = await loadAcknowledgements(
      rows.map((row) => row.riskAcknowledgementId),
      transaction,
    );
    const previous = await previousChoices(userId, draft.id, rows, transaction);
    const settled = await settleChoices(
      allocations.map((item) => {
        const { segment, rules } = getLoaded(segments, item.segmentId);
        const row = rowFor(item.segmentId);
        const assessment = assess(segment, rules, row.capital ?? '0', item.riskPercent);
        if (!assessment) throw new Error('Capital was checked against the bands above');
        const existing = existingAcks.get(row.riskAcknowledgementId ?? '');
        return {
          assessment,
          acknowledgement: item.acknowledgement,
          existing,
          previousCapital: previous.get(item.segmentId)?.capital ?? null,
          previousRiskPercent: previous.get(item.segmentId)?.riskPercent ?? null,
        };
      }),
      transaction,
    );
    const covering = await recordAcknowledgements(
      settled,
      { userId, riskProfileId: draft.id, source: 'onboarding', context },
      transaction,
    );

    const before: Record<string, string | null> = {};
    const after: Record<string, string> = {};
    const acknowledged: Record<string, string> = {};
    for (const { assessment } of settled) {
      const { segment, rules } = assessment;
      const row = rowFor(segment.id);
      before[segment.code] = row.riskPercent;
      row.riskPercent = formatPercent(assessment.riskPercent);
      row.riskBasis = segment.riskBasis;
      row.ruleSetId = rules.ruleSet.id;
      row.riskAcknowledgementId = covering.get(segment.id) ?? null;
      after[segment.code] = row.riskPercent;
      if (assessment.required) acknowledged[segment.code] = assessment.required;
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
        after: { riskPercent: after, acknowledged },
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
 * bands (an admin may have changed them since a step was saved), including
 * that each risk above the suggested level is covered by an accepted
 * disclaimer for the very same values. Then the draft becomes the active
 * profile and the user is marked onboarded — atomically.
 */
export async function confirmOnboarding(userId: string, context: RequestContext) {
  const profileId = await withDraft(userId, async ({ user, draft, rows, transaction }) => {
    const filled = rows.filter((row) => row.capital !== null);
    const segments = rows.length > 0 ? await loadSelectableSegments(rows.map((row) => row.segmentId), transaction) : new Map<string, SegmentWithRules>();

    throwIfViolations(
      filled.map((row) => {
        const { segment, rules } = getLoaded(segments, row.segmentId);
        return capitalViolation(segment, rules, row.capital ?? '0');
      }),
      ErrorCode.CAPITAL_BELOW_MINIMUM,
      'Capital is below the current minimum for one or more segments',
    );
    const complete = filled.filter((row) => row.riskPercent !== null);
    throwIfViolations(
      complete.map((row) => {
        const { segment, rules } = getLoaded(segments, row.segmentId);
        return riskViolation(segment, rules, row.capital ?? '0', row.riskPercent ?? '0');
      }),
      ErrorCode.RISK_OUT_OF_RANGE,
      'Risk is outside the current allowed range for one or more segments',
    );
    const acks = await loadAcknowledgements(
      complete.map((row) => row.riskAcknowledgementId),
      transaction,
    );
    await settleChoices(
      complete.map((row) => {
        const { segment, rules } = getLoaded(segments, row.segmentId);
        const assessment = assess(segment, rules, row.capital ?? '0', row.riskPercent ?? '0');
        if (!assessment) throw new Error('Capital was checked against the bands above');
        return { assessment, existing: acks.get(row.riskAcknowledgementId ?? '') };
      }),
      transaction,
    );

    const pending = await getPendingPolicies(userId, transaction);
    const steps = computeSteps(user, draft, rows, await checkRows(rows, transaction), pending.length);
    const incomplete = ONBOARDING_STEPS.filter((step) => !steps[step]);
    if (incomplete.length > 0) {
      throw AppError.unprocessable(
        'Please complete all onboarding steps before confirming',
        ErrorCode.ONBOARDING_INCOMPLETE,
        incomplete.map((step) => ({ path: step, message: 'Step not completed', step })),
      );
    }
    await assertPoliciesAccepted(userId, transaction);

    // The values were just checked against the bands in force: record which version.
    for (const row of rows) {
      const current: CurrentRules = getLoaded(segments, row.segmentId).rules;
      if (row.ruleSetId !== current.ruleSet.id) {
        row.ruleSetId = current.ruleSet.id;
        await row.save({ transaction });
      }
    }

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
