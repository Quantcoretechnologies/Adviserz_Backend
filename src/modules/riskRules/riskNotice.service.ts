import { Op, QueryTypes, type Transaction } from 'sequelize';
import { z } from 'zod';
import { sequelize } from '../../db/sequelize.js';
import { AppError } from '../../common/errors/AppError.js';
import { ErrorCode } from '../../common/errors/errorCodes.js';
import type { RequestContext } from '../../common/http/requestContext.js';
import { sha256Hex } from '../../common/utils/crypto.js';
import { formatMoney, formatPercent, toDecimal } from '../../common/utils/decimal.js';
import {
  RiskNoticeAcceptance,
  RiskNoticeAcceptanceSegment,
  RiskProfileSegment,
  RiskRuleSet,
  User,
  type PolicyDocument,
  type RiskProfile,
  type Segment,
} from '../../models/index.js';
import type { RiskNoticeStatus } from '../../models/enums.js';
import { recordAudit } from '../audit/audit.service.js';
import { AuditAction } from '../audit/auditActions.js';
import { capitalSchema, findProfile, riskPercentSchema, serializeRiskProfile, uniqueSegmentIds } from '../riskProfile/riskProfile.domain.js';
import {
  assertAllocationsInRange,
  createNextActiveVersion,
  getLoadedSegment,
} from '../riskProfile/riskProfile.service.js';
import { loadSelectableSegments } from '../segments/segment.service.js';
import {
  acknowledgementCovers,
  acknowledgementSchema,
  assess,
  buildDisclaimer,
  loadAcknowledgements,
  recordAcknowledgements,
  serializeDisclaimer,
  settleChoices,
  type Assessment,
} from './riskAcknowledgement.service.js';
import {
  formatAmount,
  formatPercentText,
  getCurrentDisclaimerDocument,
  renderTemplate,
  riskAmountPeriod,
} from './riskDisclaimers.js';
import {
  loadCurrentRules,
  loadRuleSetByVersion,
  minimumCapital,
  bandChanges,
  sameLimits,
  serializedBandFor,
  type CurrentRules,
} from './riskRules.domain.js';

/**
 * Risk-limit change notices.
 *
 * When an admin saves new bands for a segment, every customer who holds that
 * segment in their active risk profile owes a notice. The baseline for each
 * of their segments is the newest version they have seen: the one their
 * values were last saved against, or the newest notice they accepted. A
 * notice is pending when a NOTIFYING version newer than that baseline exists.
 *
 * Several admin changes in a row make ONE notice: it compares the user's
 * baseline with the bands in force now. When those are the same (an edit
 * and its undo), that segment needs no notice.
 *
 * Until the notice is accepted the user is blocked from everything after
 * onboarding (like an unaccepted Terms version). For each segment the notice
 * says what the change means for the user's own values:
 *
 *   ok                 accept the notice
 *   needs_caution_ack  now above the suggested level: also accept that disclaimer
 *   needs_strict_ack   now above the maximum: also accept the strict disclaimer
 *   must_change        capital or risk now below the minimum: send new values
 *
 * The user may also send new values for any pending segment instead.
 */

interface PendingSegment {
  row: RiskProfileSegment;
  segment: Segment;
  fromRules: CurrentRules | null;
  toRules: CurrentRules;
}

interface PendingState {
  profile: RiskProfile;
  pending: PendingSegment[];
}

interface BaselineRow {
  segment_id: string;
  version: number;
}

/**
 * Which of the user's active segments have a notifying change newer than what
 * they have seen. Cheap enough for the route guard: a few indexed queries.
 */
async function loadPendingState(userId: string, transaction?: Transaction): Promise<PendingState | null> {
  const profile = await findProfile({ userId, status: 'active' }, transaction);
  const rows = profile?.segments ?? [];
  if (!profile || rows.length === 0) return null;
  const segmentIds = rows.map((row) => row.segmentId);

  const [notifying, accepted, rowRuleSets] = await Promise.all([
    sequelize.query<BaselineRow>(
      `SELECT segment_id, MAX(version) AS version FROM segment_risk_rule_sets
        WHERE notify_users AND segment_id IN (:segmentIds) GROUP BY segment_id`,
      { type: QueryTypes.SELECT, replacements: { segmentIds }, transaction },
    ),
    sequelize.query<BaselineRow>(
      `SELECT segment_id, MAX(to_version) AS version FROM risk_notice_acceptance_segments
        WHERE user_id = :userId AND segment_id IN (:segmentIds) GROUP BY segment_id`,
      { type: QueryTypes.SELECT, replacements: { userId, segmentIds }, transaction },
    ),
    RiskRuleSet.findAll({
      where: { id: { [Op.in]: rows.map((row) => row.ruleSetId).filter((id): id is string => id !== null) } },
      attributes: ['id', 'version'],
      transaction,
    }),
  ]);
  const notifyVersion = new Map(notifying.map((row) => [row.segment_id, Number(row.version)]));
  const acceptedVersion = new Map(accepted.map((row) => [row.segment_id, Number(row.version)]));
  const ruleSetVersion = new Map(rowRuleSets.map((ruleSet) => [ruleSet.id, ruleSet.version]));

  const owed = rows.filter((row) => {
    const latest = notifyVersion.get(row.segmentId);
    if (latest === undefined) return false;
    const baseline = Math.max(
      row.ruleSetId ? (ruleSetVersion.get(row.ruleSetId) ?? 0) : 0,
      acceptedVersion.get(row.segmentId) ?? 0,
    );
    return latest > baseline;
  });
  if (owed.length === 0) return null;

  const current = await loadCurrentRules(
    owed.map((row) => row.segmentId),
    transaction,
  );
  const pending: PendingSegment[] = [];
  for (const row of owed) {
    const toRules = current.get(row.segmentId);
    // A segment switched off by an admin cannot be acted on; it is not part of the notice.
    if (!toRules || !row.segment?.isActive) continue;
    const baseline = Math.max(
      row.ruleSetId ? (ruleSetVersion.get(row.ruleSetId) ?? 0) : 0,
      acceptedVersion.get(row.segmentId) ?? 0,
    );
    // Values saved before bands existed compare against version 1 (the old single range).
    const fromRules = await loadRuleSetByVersion(row.segmentId, Math.max(baseline, 1), transaction);
    // Changes that net out (an edit and its undo) leave this customer with nothing to accept.
    if (sameLimits(fromRules, toRules)) continue;
    pending.push({ row, segment: row.segment, fromRules, toRules });
  }
  return pending.length > 0 ? { profile, pending } : null;
}

export async function hasPendingRiskNotice(userId: string, transaction?: Transaction): Promise<boolean> {
  return (await loadPendingState(userId, transaction)) !== null;
}

/** Route guard: throw RISK_NOTICE_PENDING while a change notice is unaccepted. */
export async function assertNoPendingRiskNotice(userId: string, transaction?: Transaction): Promise<void> {
  if (await hasPendingRiskNotice(userId, transaction)) {
    throw new AppError(
      403,
      ErrorCode.RISK_NOTICE_PENDING,
      'Risk limits for your segments have changed. Please review and accept the update to continue',
    );
  }
}

// ---------------------------------------------------------------------------
// Building the notice
// ---------------------------------------------------------------------------

interface NoticeEntry {
  pending: PendingSegment;
  status: RiskNoticeStatus;
  reason: 'capital_below_minimum' | 'risk_below_minimum' | null;
  assessment: Assessment | null;
  json: Record<string, unknown>;
}

function statusFor(
  assessment: Assessment | null,
  existingCovers: boolean,
): Pick<NoticeEntry, 'status' | 'reason'> {
  if (!assessment) return { status: 'must_change', reason: 'capital_below_minimum' };
  if (assessment.level === 'below_minimum' || assessment.level === 'above_ceiling') {
    return { status: 'must_change', reason: 'risk_below_minimum' };
  }
  if (assessment.required === null || existingCovers) return { status: 'ok', reason: null };
  return { status: assessment.required === 'above_maximum' ? 'needs_strict_ack' : 'needs_caution_ack', reason: null };
}

function percentChange(label: string, before: string | undefined, after: string): string {
  if (before === undefined) return `${label} ${formatPercentText(after)}`;
  return toDecimal(before).eq(after)
    ? `${label} ${formatPercentText(after)} (unchanged)`
    : `${label} ${formatPercentText(before)} → ${formatPercentText(after)}`;
}

/** The plain-text paragraph about one segment, as it appears in the notice. */
function describeSegment(entry: NoticeEntry): string {
  const { segment, row, fromRules, toRules } = entry.pending;
  const capital = row.capital ?? '0';
  const lines = [segment.name];
  const oldMin = fromRules ? minimumCapital(fromRules) : null;
  const newMin = minimumCapital(toRules);
  if (oldMin !== null && !toDecimal(oldMin).eq(newMin)) {
    lines.push(`Minimum capital: ${formatAmount(oldMin, segment.currency)} → ${formatAmount(newMin, segment.currency)}.`);
  }
  const oldBand = fromRules ? serializedBandFor(fromRules, capital) : null;
  const newBand = serializedBandFor(toRules, capital);
  if (newBand) {
    lines.push(
      `For your capital of ${formatAmount(capital, segment.currency)}: ` +
        [
          percentChange('minimum', oldBand?.minRiskPercent, newBand.minRiskPercent),
          percentChange('suggested', oldBand?.suggestedRiskPercent, newBand.suggestedRiskPercent),
          percentChange('maximum', oldBand?.maxRiskPercent, newBand.maxRiskPercent),
        ].join(', ') +
        '.',
    );
  } else {
    lines.push(
      `Your capital of ${formatAmount(capital, segment.currency)} is now below the minimum capital of ${formatAmount(newMin, segment.currency)}.`,
    );
  }
  const changed = bandChanges(fromRules, toRules).length;
  if (changed > 0) lines.push(`Capital ranges updated in this segment: ${changed}.`);
  if (row.riskPercent) {
    lines.push(
      `Your current setting: ${formatPercentText(row.riskPercent)} (${formatAmount(
        entry.assessment?.riskAmount ?? formatMoney(toDecimal(capital).times(row.riskPercent).dividedBy(100).toDecimalPlaces(2)),
        segment.currency,
      )} ${riskAmountPeriod(segment.riskBasis)}).`,
    );
  }
  return lines.join('\n');
}

function describeAction(entry: NoticeEntry): string | null {
  const name = entry.pending.segment.name;
  if (entry.status === 'must_change') {
    return entry.reason === 'capital_below_minimum'
      ? `Your capital for ${name} is now below the minimum allowed. Please update it to continue.`
      : `Your current risk level for ${name} is now below the minimum allowed. Please update it to continue.`;
  }
  if (entry.status === 'needs_caution_ack') {
    return `Your current risk level for ${name} is above the suggested level for your capital. The disclaimer for it is shown with this notice.`;
  }
  if (entry.status === 'needs_strict_ack') {
    return `Your current risk level for ${name} is above the maximum limit for your capital. The disclaimer for it is shown with this notice.`;
  }
  return null;
}

interface BuiltNotice {
  state: PendingState;
  entries: NoticeEntry[];
  document: PolicyDocument;
  statement: string;
  notice: Record<string, unknown>;
  noticeSha256: string;
}

async function buildNotice(state: PendingState, transaction?: Transaction): Promise<BuiltNotice> {
  const acks = await loadAcknowledgements(
    state.pending.map((item) => item.row.riskAcknowledgementId),
    transaction,
  );
  const entries: NoticeEntry[] = state.pending.map((pending) => {
    const { row, segment, fromRules, toRules } = pending;
    const capital = row.capital ?? '0';
    const assessment = row.riskPercent ? assess(segment, toRules, capital, row.riskPercent) : null;
    const covers = assessment ? acknowledgementCovers(acks.get(row.riskAcknowledgementId ?? ''), assessment) : false;
    const { status, reason } = statusFor(assessment, covers);
    return {
      pending,
      status,
      reason,
      assessment,
      json: {
        segmentId: segment.id,
        code: segment.code,
        name: segment.name,
        riskBasis: segment.riskBasis,
        currency: segment.currency,
        fromRuleSet: fromRules ? { id: fromRules.ruleSet.id, version: fromRules.ruleSet.version } : null,
        toRuleSet: { id: toRules.ruleSet.id, version: toRules.ruleSet.version },
        minCapital: { before: fromRules ? minimumCapital(fromRules) : null, after: minimumCapital(toRules) },
        bandChanges: bandChanges(fromRules, toRules),
        yourValues: {
          capital: formatMoney(capital),
          riskPercent: row.riskPercent ? formatPercent(row.riskPercent) : null,
          riskAmount: assessment?.riskAmount ?? null,
        },
        yourBand: {
          before: fromRules ? serializedBandFor(fromRules, capital) : null,
          after: serializedBandFor(toRules, capital),
        },
        status,
        reason,
      },
    };
  });

  const document = await getCurrentDisclaimerDocument('risk_limits_change_notice', transaction);
  const statement = renderTemplate(document.content, {
    changes: entries.map(describeSegment).join('\n\n'),
    actions: entries
      .map(describeAction)
      .filter((line): line is string => line !== null)
      .join('\n'),
  });
  const notice = {
    policy: {
      id: document.id,
      version: document.version,
      title: document.title,
      contentSha256: document.contentSha256,
    },
    title: document.title,
    statement,
    segments: entries.map((entry) => entry.json),
  };
  return { state, entries, document, statement, notice, noticeSha256: sha256Hex(JSON.stringify(notice)) };
}

/** The pending notice for the user, with the disclaimers it needs, or `required: false`. */
export async function getRiskNotice(userId: string) {
  const state = await loadPendingState(userId);
  if (!state) return { required: false, notice: null };
  const built = await buildNotice(state);
  const disclaimers = [];
  for (const entry of built.entries) {
    if (entry.assessment && (entry.status === 'needs_caution_ack' || entry.status === 'needs_strict_ack')) {
      disclaimers.push({ segmentId: entry.pending.segment.id, ...serializeDisclaimer(await buildDisclaimer(entry.assessment)) });
    }
  }
  return {
    required: true,
    notice: {
      ...built.notice,
      noticeSha256: built.noticeSha256,
      policyDocumentId: built.document.id,
      riskProfileVersion: state.profile.version,
      disclaimers,
    },
  };
}

// ---------------------------------------------------------------------------
// Accepting
// ---------------------------------------------------------------------------

export const acceptRiskNoticeBody = z.object({
  noticeSha256: z.string({ error: 'Notice fingerprint is required' }).regex(/^[0-9a-f]{64}$/, 'Invalid notice fingerprint'),
  policyDocumentId: z.uuid({ error: 'Invalid notice id' }),
  /** Per pending segment: new values (required for must_change) and/or the disclaimer acceptance. */
  segments: z
    .array(
      z.object({
        segmentId: z.uuid({ error: 'Invalid segment id' }),
        capital: capitalSchema.optional(),
        riskPercent: riskPercentSchema.optional(),
        acknowledgement: acknowledgementSchema.optional(),
      }),
    )
    .max(20, 'Too many segments')
    .refine(uniqueSegmentIds, 'Duplicate segments are not allowed')
    .default([]),
});

export type AcceptRiskNoticeInput = z.output<typeof acceptRiskNoticeBody>;

/**
 * Accept the pending notice exactly as it was shown (its fingerprint must
 * match the notice as it stands now). Values that no longer fit must be
 * replaced in the same request; a value above the suggested or maximum level
 * needs its disclaimer. Everything is stored together or not at all: the
 * notice acceptance with its full text, one row per segment, any
 * acknowledgements, and a new profile version when values changed.
 */
export async function acceptRiskNotice(userId: string, input: AcceptRiskNoticeInput, context: RequestContext) {
  await sequelize.transaction(async (transaction) => {
    const user = await User.findByPk(userId, { lock: transaction.LOCK.UPDATE, transaction });
    if (!user) throw AppError.unauthorized();
    if (user.onboardingStatus !== 'completed') {
      throw AppError.forbidden('Please complete onboarding to continue', ErrorCode.ONBOARDING_REQUIRED);
    }

    const state = await loadPendingState(userId, transaction);
    if (!state) {
      throw AppError.conflict('There is no risk-limit update to accept', ErrorCode.RISK_NOTICE_OUTDATED);
    }
    const built = await buildNotice(state, transaction);
    if (built.noticeSha256 !== input.noticeSha256 || built.document.id !== input.policyDocumentId) {
      throw AppError.conflict(
        'The risk limits have changed again. Please review the latest update',
        ErrorCode.RISK_NOTICE_OUTDATED,
      );
    }

    const entryBySegment = new Map(built.entries.map((entry) => [entry.pending.segment.id, entry]));
    const unknown = input.segments.filter((item) => !entryBySegment.has(item.segmentId));
    if (unknown.length > 0) {
      throw AppError.unprocessable(
        'Only segments listed in the update can be changed here',
        ErrorCode.VALIDATION_ERROR,
        unknown.map((item) => ({ path: 'segments', message: 'Segment is not part of this update', segmentId: item.segmentId })),
      );
    }

    const responses = new Map(input.segments.map((item) => [item.segmentId, item]));
    const finalValues = built.entries.map((entry) => {
      const { row, segment } = entry.pending;
      const response = responses.get(segment.id);
      const capital = response?.capital ?? row.capital ?? '0';
      const riskPercent = response?.riskPercent ?? row.riskPercent ?? '0';
      const changed = !toDecimal(capital).eq(row.capital ?? '0') || !toDecimal(riskPercent).eq(row.riskPercent ?? '0');
      return { entry, capital, riskPercent, changed, acknowledgement: response?.acknowledgement };
    });

    const segments = await loadSelectableSegments(
      finalValues.map((value) => value.entry.pending.segment.id),
      transaction,
    );
    assertAllocationsInRange(
      segments,
      finalValues.map((value) => ({
        segmentId: value.entry.pending.segment.id,
        capital: value.capital,
        riskPercent: value.riskPercent,
      })),
    );

    const existingAcks = await loadAcknowledgements(
      finalValues.map((value) => value.entry.pending.row.riskAcknowledgementId),
      transaction,
    );
    const settled = await settleChoices(
      finalValues.map((value) => {
        const { segment, rules } = getLoadedSegment(segments, value.entry.pending.segment.id);
        const assessment = assess(segment, rules, value.capital, value.riskPercent);
        if (!assessment) throw new Error('Capital was checked against the bands above');
        const { row } = value.entry.pending;
        return {
          assessment,
          acknowledgement: value.acknowledgement,
          existing: existingAcks.get(row.riskAcknowledgementId ?? ''),
          previousCapital: row.capital,
          previousRiskPercent: row.riskPercent,
        };
      }),
      transaction,
    );

    const anyChanged = finalValues.some((value) => value.changed);
    const profile = state.profile;
    let profileId = profile.id;
    if (anyChanged) {
      const pendingIds = new Set(finalValues.map((value) => value.entry.pending.segment.id));
      const finalBySegment = new Map(finalValues.map((value) => [value.entry.pending.segment.id, value]));
      const next = await createNextActiveVersion(
        {
          userId,
          current: profile,
          marketExperience: profile.marketExperience ?? 'new',
          source: 'risk_notice',
          rows: (profile.segments ?? []).map((row) => {
            const final = finalBySegment.get(row.segmentId);
            return {
              segmentId: row.segmentId,
              riskBasis: row.riskBasis,
              currency: row.currency,
              capital: final ? final.capital : (row.capital ?? '0'),
              riskPercent: final ? final.riskPercent : (row.riskPercent ?? '0'),
              ruleSetId: pendingIds.has(row.segmentId)
                ? getLoadedSegment(segments, row.segmentId).rules.ruleSet.id
                : row.ruleSetId,
              riskAcknowledgementId: pendingIds.has(row.segmentId) ? null : row.riskAcknowledgementId,
            };
          }),
        },
        transaction,
      );
      profileId = next.id;
    }

    const covering = await recordAcknowledgements(
      settled,
      { userId, riskProfileId: profileId, source: 'risk_notice', context },
      transaction,
    );
    for (const value of finalValues) {
      const segmentId = value.entry.pending.segment.id;
      const ackId = covering.get(segmentId) ?? null;
      if (anyChanged || ackId !== value.entry.pending.row.riskAcknowledgementId) {
        await RiskProfileSegment.update(
          { riskAcknowledgementId: ackId },
          { where: { riskProfileId: profileId, segmentId, isDeleted: false }, transaction },
        );
      }
    }

    const acceptance = await RiskNoticeAcceptance.create(
      {
        userId,
        riskProfileId: profileId,
        notice: built.notice,
        noticeSha256: built.noticeSha256,
        policyDocumentId: built.document.id,
        policyContentSha256: built.document.contentSha256,
        statement: built.statement,
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
        requestId: context.requestId,
      },
      { transaction },
    );
    await RiskNoticeAcceptanceSegment.bulkCreate(
      finalValues.map((value) => {
        const { segment, fromRules, toRules } = value.entry.pending;
        return {
          acceptanceId: acceptance.id,
          userId,
          segmentId: segment.id,
          fromRuleSetId: fromRules?.ruleSet.id ?? null,
          toRuleSetId: toRules.ruleSet.id,
          toVersion: toRules.ruleSet.version,
          status: value.entry.status,
          valuesChanged: value.changed,
          riskAcknowledgementId: covering.get(segment.id) ?? null,
        };
      }),
      { transaction },
    );

    await recordAudit(
      {
        actor: { type: 'user', id: userId },
        action: AuditAction.RISK_NOTICE_ACCEPTED,
        entityType: 'risk_notice_acceptance',
        entityId: acceptance.id,
        subjectUserId: userId,
        before: {
          segments: finalValues.map((value) => ({
            code: value.entry.pending.segment.code,
            version: value.entry.pending.fromRules?.ruleSet.version ?? null,
            capital: value.entry.pending.row.capital,
            riskPercent: value.entry.pending.row.riskPercent,
          })),
        },
        after: {
          noticeSha256: built.noticeSha256,
          notice: { id: built.document.id, version: built.document.version },
          riskProfileId: profileId,
          segments: finalValues.map((value) => ({
            code: value.entry.pending.segment.code,
            version: value.entry.pending.toRules.ruleSet.version,
            status: value.entry.status,
            capital: formatMoney(value.capital),
            riskPercent: formatPercent(value.riskPercent),
            valuesChanged: value.changed,
            acknowledgementId: covering.get(value.entry.pending.segment.id) ?? null,
          })),
        },
        context,
      },
      transaction,
    );
  });

  const profile = await findProfile({ userId, status: 'active' });
  return { accepted: true, riskProfile: profile ? serializeRiskProfile(profile) : null };
}

