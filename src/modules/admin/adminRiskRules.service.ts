import { QueryTypes, type Transaction } from 'sequelize';
import { sequelize } from '../../db/sequelize.js';
import { AppError } from '../../common/errors/AppError.js';
import { ErrorCode } from '../../common/errors/errorCodes.js';
import type { RequestContext } from '../../common/http/requestContext.js';
import { formatMoney, formatPercent, toDecimal } from '../../common/utils/decimal.js';
import { toPagination } from '../../common/utils/validation.js';
import {
  Admin,
  RiskAcknowledgement,
  RiskBand,
  RiskNoticeAcceptance,
  RiskNoticeAcceptanceSegment,
  RiskRuleSet,
  Segment,
  User,
} from '../../models/index.js';
import type { RiskRuleSetSource, SuggestedRiskMode } from '../../models/enums.js';
import { recordAudit } from '../audit/audit.service.js';
import { AuditAction } from '../audit/auditActions.js';
import { createNotifications, settleRiskAlerts } from '../notifications/notification.service.js';
import {
  acknowledgementCovers,
  assess,
  loadAcknowledgements,
  serializeAcknowledgement,
} from '../riskRules/riskAcknowledgement.service.js';
import {
  bandChanges,
  loadCurrentRules,
  loadRuleSetByVersion,
  midpointPercent,
  minimumCapital,
  sameLimits,
  serializeRules,
  type CurrentRules,
} from '../riskRules/riskRules.domain.js';

/**
 * Admin management of each segment's capital-band risk limits.
 *
 * The whole table is saved at once and becomes a new version; earlier
 * versions are kept unchanged. Every admin save notifies the customers who
 * hold the segment (see riskRules/riskNotice.service). `?preview=true`
 * validates the table and reports what it would mean for those customers
 * without saving anything.
 */

export interface BandInput {
  capitalFrom: string;
  minRiskPercent: string;
  maxRiskPercent: string;
  suggestedRiskPercent?: string | undefined;
}

export interface RiskRulesInput {
  suggestedMode?: SuggestedRiskMode | undefined;
  bands: BandInput[];
}

interface NormalisedBand {
  capitalFrom: string;
  minRiskPercent: string;
  suggestedRiskPercent: string;
  maxRiskPercent: string;
}

async function loadSegment(segmentId: string, transaction?: Transaction): Promise<Segment> {
  const segment = await Segment.findByPk(segmentId, transaction ? { transaction, lock: transaction.LOCK.UPDATE } : {});
  if (!segment) throw AppError.notFound('Segment not found');
  return segment;
}

/**
 * Check the table and work out each band's suggested value. Errors name the
 * band by its position (bands.<index>.<field>) so the screen can mark it.
 */
export function normaliseBands(mode: SuggestedRiskMode, bands: BandInput[]): NormalisedBand[] {
  const problems: { path: string; message: string }[] = [];
  const normalised = bands.map((band, index) => {
    const min = toDecimal(band.minRiskPercent);
    const max = toDecimal(band.maxRiskPercent);
    if (min.lte(0)) problems.push({ path: `bands.${index}.minRiskPercent`, message: 'Minimum risk must be greater than 0' });
    if (max.gt(100)) problems.push({ path: `bands.${index}.maxRiskPercent`, message: 'Maximum risk cannot be more than 100%' });
    if (min.gt(max)) {
      problems.push({ path: `bands.${index}.minRiskPercent`, message: 'Minimum risk cannot be more than the maximum' });
    }

    let suggested: string;
    if (mode === 'midpoint') {
      if (band.suggestedRiskPercent !== undefined) {
        problems.push({
          path: `bands.${index}.suggestedRiskPercent`,
          message: 'Suggested risk is worked out as the midpoint of minimum and maximum; leave it out',
        });
      }
      suggested = midpointPercent(band.minRiskPercent, band.maxRiskPercent);
    } else {
      if (band.suggestedRiskPercent === undefined) {
        problems.push({ path: `bands.${index}.suggestedRiskPercent`, message: 'Suggested risk is required' });
        suggested = band.maxRiskPercent;
      } else {
        suggested = band.suggestedRiskPercent;
        const value = toDecimal(suggested);
        if (value.lt(min) || value.gt(max)) {
          problems.push({
            path: `bands.${index}.suggestedRiskPercent`,
            message: 'Suggested risk must be between the minimum and the maximum',
          });
        }
      }
    }

    const previous = bands[index - 1];
    if (previous && !toDecimal(band.capitalFrom).gt(previous.capitalFrom)) {
      problems.push({
        path: `bands.${index}.capitalFrom`,
        message: 'Each band must start at a higher capital than the band before it',
      });
    }
    return {
      capitalFrom: formatMoney(band.capitalFrom),
      minRiskPercent: formatPercent(band.minRiskPercent),
      suggestedRiskPercent: formatPercent(suggested),
      maxRiskPercent: formatPercent(band.maxRiskPercent),
    };
  });
  if (problems.length > 0) {
    throw AppError.unprocessable('The risk band table is not valid', ErrorCode.VALIDATION_ERROR, problems);
  }
  return normalised;
}

/** An unsaved rule set, so the band maths can run on a table before it is stored. */
function inMemoryRules(segmentId: string, version: number, mode: SuggestedRiskMode, bands: NormalisedBand[]): CurrentRules {
  const ruleSet = RiskRuleSet.build({ segmentId, version, suggestedMode: mode, source: 'admin', notifyUsers: true });
  return { ruleSet, bands: bands.map((band) => RiskBand.build({ ruleSetId: ruleSet.id, ...band })) };
}

function sameTable(current: CurrentRules, mode: SuggestedRiskMode, bands: NormalisedBand[]): boolean {
  return (
    current.ruleSet.suggestedMode === mode &&
    current.bands.length === bands.length &&
    current.bands.every((band, index) => {
      const next = bands[index];
      return (
        next !== undefined &&
        toDecimal(band.capitalFrom).eq(next.capitalFrom) &&
        toDecimal(band.minRiskPercent).eq(next.minRiskPercent) &&
        toDecimal(band.suggestedRiskPercent).eq(next.suggestedRiskPercent) &&
        toDecimal(band.maxRiskPercent).eq(next.maxRiskPercent)
      );
    })
  );
}

interface HolderRow {
  user_id: string;
  capital: string;
  risk_percent: string;
  risk_acknowledgement_id: string | null;
  baseline_version: number;
}

/**
 * The version each holder of the segment has last seen: the one their values
 * were saved against or the newest notice they accepted (values saved before
 * bands existed count as version 1), as the notice service works it out.
 */
const HOLDER_BASELINES = `
  SELECT rp.user_id, rps.capital, rps.risk_percent, rps.risk_acknowledgement_id,
         GREATEST(
           COALESCE(rs.version, 0),
           COALESCE((SELECT MAX(s.to_version) FROM risk_notice_acceptance_segments s
                      WHERE s.user_id = rp.user_id AND s.segment_id = rps.segment_id), 0),
           1
         ) AS baseline_version
    FROM risk_profiles rp
    JOIN risk_profile_segments rps ON rps.risk_profile_id = rp.id
    LEFT JOIN segment_risk_rule_sets rs ON rs.id = rps.rule_set_id
   WHERE rp.status = 'active' AND rps.segment_id = :segmentId AND rps.is_deleted = FALSE`;

/** Every stored version of a segment's bands, by version number. */
async function loadAllVersions(segmentId: string, transaction?: Transaction): Promise<Map<number, CurrentRules>> {
  const ruleSets = await RiskRuleSet.findAll({
    where: { segmentId },
    include: [{ model: RiskBand, as: 'bands' }],
    transaction,
  });
  const versions = new Map<number, CurrentRules>();
  for (const ruleSet of ruleSets) {
    const bands = [...(ruleSet.bands ?? [])].sort((a, b) => toDecimal(a.capitalFrom).comparedTo(toDecimal(b.capitalFrom)));
    versions.set(ruleSet.version, { ruleSet, bands });
  }
  return versions;
}

/** Versions that give a customer exactly the same limits as `rules`. */
function versionsLike(versions: Map<number, CurrentRules>, rules: CurrentRules): number[] {
  return [...versions.entries()].filter(([, candidate]) => sameLimits(candidate, rules)).map(([version]) => version);
}

/**
 * What a table would mean for the customers holding the segment right now.
 * `notified` counts those it would block with a notice: everyone except
 * customers whose last-seen limits are exactly this table already
 * (`notifiedUserIds` lists them; it is never sent to the admin).
 */
async function impactOf(segment: Segment, rules: CurrentRules, transaction?: Transaction) {
  const holders = await sequelize.query<HolderRow>(
    `${HOLDER_BASELINES} AND rps.capital IS NOT NULL AND rps.risk_percent IS NOT NULL`,
    { type: QueryTypes.SELECT, replacements: { segmentId: segment.id }, transaction },
  );
  const [acks, versions] = await Promise.all([
    loadAcknowledgements(
      holders.map((row) => row.risk_acknowledgement_id),
      transaction,
    ),
    loadAllVersions(segment.id, transaction),
  ]);
  const unchangedFor = new Set(versionsLike(versions, rules));
  const notifiedUserIds = [
    ...new Set(holders.filter((row) => !unchangedFor.has(Number(row.baseline_version))).map((row) => row.user_id)),
  ];
  // Holders whose last-seen limits are exactly this table: nothing to accept
  // for this segment, so any earlier alert about it is settled.
  const settledUserIds = [
    ...new Set(holders.filter((row) => unchangedFor.has(Number(row.baseline_version))).map((row) => row.user_id)),
  ];
  const impact = {
    customers: holders.length,
    notified: notifiedUserIds.length,
    ok: 0,
    needsCautionAck: 0,
    needsStrictAck: 0,
    mustChange: 0,
  };
  for (const row of holders) {
    const assessment = assess(segment, rules, row.capital, row.risk_percent);
    if (!assessment || assessment.level === 'below_minimum' || assessment.level === 'above_ceiling') impact.mustChange += 1;
    else if (!assessment.required || acknowledgementCovers(acks.get(row.risk_acknowledgement_id ?? ''), assessment)) {
      impact.ok += 1;
    } else if (assessment.required === 'above_maximum') impact.needsStrictAck += 1;
    else impact.needsCautionAck += 1;
  }
  return { impact, notifiedUserIds, settledUserIds };
}

function changeSummary(current: CurrentRules | null, next: CurrentRules) {
  return {
    fromVersion: current?.ruleSet.version ?? null,
    minCapital: { before: current ? minimumCapital(current) : null, after: minimumCapital(next) },
    suggestedMode: { before: current?.ruleSet.suggestedMode ?? null, after: next.ruleSet.suggestedMode },
    bands: bandChanges(current, next),
  };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

function serializeVersion(ruleSet: RiskRuleSet & { createdBy?: Admin | null }) {
  return {
    id: ruleSet.id,
    version: ruleSet.version,
    suggestedMode: ruleSet.suggestedMode,
    source: ruleSet.source,
    notifyUsers: ruleSet.notifyUsers,
    changeSummary: ruleSet.changeSummary,
    createdAt: ruleSet.createdAt,
    createdBy: ruleSet.createdBy ? { id: ruleSet.createdBy.id, fullName: ruleSet.createdBy.fullName } : null,
  };
}

export async function getRiskRules(segmentId: string) {
  const segment = await loadSegment(segmentId);
  const [current, versions] = await Promise.all([
    loadCurrentRules([segment.id]),
    RiskRuleSet.findAll({
      where: { segmentId },
      include: [{ model: Admin, as: 'createdBy', attributes: ['id', 'fullName'] }],
      order: [['version', 'DESC']],
    }),
  ]);
  const rules = current.get(segment.id);
  return {
    segment: { id: segment.id, code: segment.code, name: segment.name, riskBasis: segment.riskBasis, currency: segment.currency },
    current: rules ? serializeRules(rules) : null,
    versions: versions.map(serializeVersion),
  };
}

export async function getRiskRuleVersion(segmentId: string, version: number) {
  await loadSegment(segmentId);
  const rules = await loadRuleSetByVersion(segmentId, version);
  if (!rules) throw AppError.notFound('Version not found');
  return { ...serializeRules(rules), notifyUsers: rules.ruleSet.notifyUsers, changeSummary: rules.ruleSet.changeSummary };
}

// ---------------------------------------------------------------------------
// Saving
// ---------------------------------------------------------------------------

/**
 * Store a new version of a segment's bands. With `preview`, nothing is
 * written: the response shows the table as it would be saved, the changes
 * and the impact on customers.
 */
export async function saveRiskRules(
  adminId: string,
  segmentId: string,
  input: RiskRulesInput,
  context: RequestContext,
  options: { preview: boolean },
) {
  return sequelize.transaction(async (transaction) => {
    const segment = await loadSegment(segmentId, transaction);
    const current = (await loadCurrentRules([segment.id], transaction)).get(segment.id) ?? null;
    const mode = input.suggestedMode ?? current?.ruleSet.suggestedMode ?? segment.suggestedMode;
    const bands = normaliseBands(mode, input.bands);
    if (current && sameTable(current, mode, bands)) {
      throw AppError.unprocessable('These risk bands are the same as the ones in force', ErrorCode.NO_CHANGES);
    }

    const version = (current?.ruleSet.version ?? 0) + 1;
    const next = inMemoryRules(segment.id, version, mode, bands);
    const summary = changeSummary(current, next);
    const { impact, notifiedUserIds, settledUserIds } = await impactOf(segment, next, transaction);

    if (options.preview) {
      return { preview: true, ruleSet: serializeRules(next), changes: summary, impact };
    }

    const saved = await createRuleSet(
      { segment, version, mode, bands, source: 'admin', notifyUsers: true, adminId, changeSummary: summary },
      transaction,
    );
    if (segment.suggestedMode !== mode) {
      segment.suggestedMode = mode;
      segment.updatedByAdminId = adminId;
      await segment.save({ transaction });
    }

    await recordAudit(
      {
        actor: { type: 'admin', id: adminId },
        action: AuditAction.ADMIN_SEGMENT_RISK_RULES_UPDATED,
        entityType: 'segment',
        entityId: segment.id,
        severity: 'warning',
        before: current ? { segment: segment.code, ...serializeRules(current) } : null,
        after: { segment: segment.code, ...serializeRules(saved) },
        metadata: { changes: summary, impact },
        context,
      },
      transaction,
    );

    // Everyone the new limits block is told right away; it reaches them live
    // once this transaction commits, or in the bell next time they open the app.
    await createNotifications(
      notifiedUserIds.map((userId) => ({
        userId,
        type: 'risk_notice.required' as const,
        title: 'Your risk limits have changed',
        body: `Adviserz has updated the limits for ${segment.name}. Please review and accept them to continue.`,
        link: '/risk-notice',
        data: { segmentId: segment.id, segmentCode: segment.code, version },
      })),
      transaction,
    );
    // Customers this table asks nothing of (e.g. the limits were changed
    // back before they responded): their earlier alerts about this segment
    // no longer lead anywhere, so they are marked read.
    await settleRiskAlerts(settledUserIds, segment.id, transaction);

    return { preview: false, ruleSet: serializeRules(saved), changes: summary, impact };
  });
}

/** Insert a rule set and its bands. Used by admin saves and segment creation. */
export async function createRuleSet(
  params: {
    segment: Segment;
    version: number;
    mode: SuggestedRiskMode;
    bands: NormalisedBand[];
    source: RiskRuleSetSource;
    notifyUsers: boolean;
    adminId: string | null;
    changeSummary: Record<string, unknown> | null;
  },
  transaction: Transaction,
): Promise<CurrentRules> {
  const ruleSet = await RiskRuleSet.create(
    {
      segmentId: params.segment.id,
      version: params.version,
      suggestedMode: params.mode,
      source: params.source,
      notifyUsers: params.notifyUsers,
      changeSummary: params.changeSummary,
      createdByAdminId: params.adminId,
    },
    { transaction },
  );
  const bands = await RiskBand.bulkCreate(
    params.bands.map((band) => ({ ruleSetId: ruleSet.id, ...band })),
    { transaction },
  );
  return { ruleSet, bands };
}

// ---------------------------------------------------------------------------
// Who has accepted a change
// ---------------------------------------------------------------------------

export type AcceptanceStatus = 'accepted' | 'pending' | 'up_to_date';

interface AcceptanceRow {
  user_id: string;
  full_name: string;
  email: string | null;
  phone: string | null;
  status: AcceptanceStatus;
  accepted_at: Date | null;
}

/**
 * For one notifying version: every customer who holds the segment now, and
 * whether they accepted the notice for it (or a later one), still owe it, or
 * saved their values under this version or later (no notice needed).
 */
export async function getRiskRuleAcceptances(
  segmentId: string,
  version: number,
  query: { status?: AcceptanceStatus | undefined; page: number; pageSize: number },
) {
  await loadSegment(segmentId);
  const rules = await loadRuleSetByVersion(segmentId, version);
  if (!rules) throw AppError.notFound('Version not found');
  if (!rules.ruleSet.notifyUsers) {
    throw AppError.unprocessable('This version did not notify customers', ErrorCode.VALIDATION_ERROR, [
      { path: 'version', message: 'Only versions saved by an admin notify customers' },
    ]);
  }

  // A holder owes nothing for this version when the limits they last saw are
  // exactly this version's, or exactly the limits in force now (the change
  // was undone later, so they are never asked).
  const versions = await loadAllVersions(segmentId);
  const current = [...versions.values()].reduce<CurrentRules | null>(
    (latest, candidate) => (!latest || candidate.ruleSet.version > latest.ruleSet.version ? candidate : latest),
    null,
  );
  const sameAsSeen = new Set([...versionsLike(versions, rules), ...(current ? versionsLike(versions, current) : [])]);

  const base = `
    WITH holders AS (${HOLDER_BASELINES}), classified AS (
      SELECT h.user_id, a.accepted_at,
             CASE WHEN a.accepted_at IS NOT NULL THEN 'accepted'
                  WHEN h.baseline_version >= :version OR h.baseline_version IN (:sameAsSeen) THEN 'up_to_date'
                  ELSE 'pending' END AS status
        FROM holders h
        LEFT JOIN LATERAL (
          SELECT MIN(s.created_at) AS accepted_at FROM risk_notice_acceptance_segments s
           WHERE s.user_id = h.user_id AND s.segment_id = :segmentId AND s.to_version >= :version
        ) a ON TRUE
    )`;
  const replacements = {
    segmentId,
    version,
    // Never empty (an empty IN list is invalid SQL); no version is numbered 0.
    sameAsSeen: [0, ...sameAsSeen],
    status: query.status ?? null,
    limit: query.pageSize,
    offset: (query.page - 1) * query.pageSize,
  };
  const [counts, items] = await Promise.all([
    sequelize.query<{ status: AcceptanceStatus; total: string }>(
      `${base} SELECT status, COUNT(*) AS total FROM classified GROUP BY status`,
      { type: QueryTypes.SELECT, replacements },
    ),
    sequelize.query<AcceptanceRow>(
      `${base} SELECT c.user_id, u.full_name, u.email, u.phone, c.status, c.accepted_at
                 FROM classified c JOIN users u ON u.id = c.user_id
                WHERE CAST(:status AS VARCHAR) IS NULL OR c.status = :status
                ORDER BY c.accepted_at DESC NULLS LAST, u.full_name ASC
                LIMIT :limit OFFSET :offset`,
      { type: QueryTypes.SELECT, replacements },
    ),
  ]);

  const summary = { accepted: 0, pending: 0, upToDate: 0, total: 0 };
  for (const row of counts) {
    const total = Number(row.total);
    summary.total += total;
    if (row.status === 'accepted') summary.accepted = total;
    else if (row.status === 'pending') summary.pending = total;
    else summary.upToDate = total;
  }
  const filteredTotal =
    query.status === undefined
      ? summary.total
      : query.status === 'accepted'
        ? summary.accepted
        : query.status === 'pending'
          ? summary.pending
          : summary.upToDate;

  return {
    version: rules.ruleSet.version,
    effectiveFrom: rules.ruleSet.createdAt,
    summary,
    items: items.map((row) => ({
      userId: row.user_id,
      fullName: row.full_name,
      email: row.email,
      phone: row.phone,
      status: row.status,
      acceptedAt: row.accepted_at,
    })),
    pagination: toPagination(query.page, query.pageSize, filteredTotal),
  };
}

// ---------------------------------------------------------------------------
// One customer's records
// ---------------------------------------------------------------------------

async function assertUserExists(userId: string): Promise<void> {
  if (!(await User.count({ where: { id: userId } }))) throw AppError.notFound('User not found');
}

export async function getUserRiskAcknowledgements(userId: string, page: number, pageSize: number) {
  await assertUserExists(userId);
  const { rows, count } = await RiskAcknowledgement.findAndCountAll({
    where: { userId },
    include: [{ model: Segment, as: 'segment', attributes: ['id', 'code', 'name'] }],
    order: [['createdAt', 'DESC']],
    limit: pageSize,
    offset: (page - 1) * pageSize,
  });
  return {
    items: rows.map((row) => {
      const segment = (row as RiskAcknowledgement & { segment?: Segment }).segment;
      return {
        ...serializeAcknowledgement(row),
        segment: segment ? { id: segment.id, code: segment.code, name: segment.name } : null,
      };
    }),
    pagination: toPagination(page, pageSize, count),
  };
}

export async function getUserRiskNoticeAcceptances(userId: string, page: number, pageSize: number) {
  await assertUserExists(userId);
  const { rows, count } = await RiskNoticeAcceptance.findAndCountAll({
    where: { userId },
    include: [{ model: RiskNoticeAcceptanceSegment, as: 'segments' }],
    order: [['createdAt', 'DESC']],
    limit: pageSize,
    offset: (page - 1) * pageSize,
    distinct: true,
  });
  return {
    items: rows.map((row) => ({
      id: row.id,
      riskProfileId: row.riskProfileId,
      notice: row.notice,
      noticeSha256: row.noticeSha256,
      policyDocumentId: row.policyDocumentId,
      policyContentSha256: row.policyContentSha256,
      statement: row.statement,
      ipAddress: row.ipAddress,
      userAgent: row.userAgent,
      createdAt: row.createdAt,
      segments: ((row as RiskNoticeAcceptance & { segments?: RiskNoticeAcceptanceSegment[] }).segments ?? []).map(
        (segment) => ({
          segmentId: segment.segmentId,
          fromRuleSetId: segment.fromRuleSetId,
          toRuleSetId: segment.toRuleSetId,
          toVersion: segment.toVersion,
          status: segment.status,
          valuesChanged: segment.valuesChanged,
          riskAcknowledgementId: segment.riskAcknowledgementId,
        }),
      ),
    })),
    pagination: toPagination(page, pageSize, count),
  };
}
