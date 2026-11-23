import { Op, type Transaction } from 'sequelize';
import { z } from 'zod';
import { AppError, type ErrorDetail } from '../../common/errors/AppError.js';
import { ErrorCode } from '../../common/errors/errorCodes.js';
import type { RequestContext } from '../../common/http/requestContext.js';
import { sha256Hex } from '../../common/utils/crypto.js';
import { formatMoney, formatPercent, toDecimal } from '../../common/utils/decimal.js';
import { RiskAcknowledgement, type PolicyDocument, type RiskBand, type Segment } from '../../models/index.js';
import {
  RISK_ACKNOWLEDGEMENT_LEVELS,
  type RiskAcknowledgementLevel,
  type RiskAcknowledgementSource,
} from '../../models/enums.js';
import { recordAudit } from '../audit/audit.service.js';
import { AuditAction } from '../audit/auditActions.js';
import {
  CONFIRMATION_PHRASE,
  DISCLAIMER_TYPE_FOR_LEVEL,
  formatAmount,
  formatPercentText,
  getCurrentDisclaimerDocument,
  matchesConfirmationPhrase,
  normalisePhrase,
  renderTemplate,
  riskAmountPeriod,
} from './riskDisclaimers.js';
import {
  acknowledgementFor,
  bandCapitalTo,
  classifyRisk,
  findBand,
  riskAmount,
  serializeBand,
  type CurrentRules,
  type RiskLevel,
} from './riskRules.domain.js';

/**
 * Acknowledgements: the user's written acceptance of a disclaimer for one
 * exact choice (segment, capital, risk %) under the limits in force.
 *
 * The client fetches the disclaimer (filled in with the user's numbers), shows
 * it, and sends back its fingerprint. The server fills the text in again and
 * accepts the acknowledgement only if the fingerprints match, so what is
 * stored is exactly what the user was shown under the current limits.
 */

export const acknowledgementSchema = z.object({
  level: z.enum(RISK_ACKNOWLEDGEMENT_LEVELS, {
    error: `Acknowledgement level must be one of: ${RISK_ACKNOWLEDGEMENT_LEVELS.join(', ')}`,
  }),
  ruleSetId: z.uuid({ error: 'Invalid rule set id' }),
  policyDocumentId: z.uuid({ error: 'Invalid disclaimer id' }),
  statementSha256: z.string({ error: 'Statement fingerprint is required' }).regex(/^[0-9a-f]{64}$/, 'Invalid statement fingerprint'),
  typedConfirmation: z.string({ error: 'Typed confirmation must be text' }).max(100).optional(),
});

export type AcknowledgementInput = z.output<typeof acknowledgementSchema>;

/** Where a choice stands under the current limits. */
export interface Assessment {
  segment: Segment;
  rules: CurrentRules;
  band: RiskBand;
  capital: string;
  riskPercent: string;
  level: RiskLevel;
  /** The disclaimer the choice needs, or null. */
  required: RiskAcknowledgementLevel | null;
  riskAmount: string;
}

/** Null when the capital is below every band. */
export function assess(segment: Segment, rules: CurrentRules, capital: string, riskPercent: string): Assessment | null {
  const band = findBand(rules, capital);
  if (!band) return null;
  const level = classifyRisk(band, riskPercent);
  return {
    segment,
    rules,
    band,
    capital: formatMoney(capital),
    riskPercent: formatPercent(riskPercent),
    level,
    required: acknowledgementFor(level),
    riskAmount: riskAmount(capital, riskPercent),
  };
}

export function serializeAssessment(assessment: Assessment) {
  const { rules, band } = assessment;
  return {
    segmentId: assessment.segment.id,
    capital: assessment.capital,
    riskPercent: assessment.riskPercent,
    riskAmount: assessment.riskAmount,
    level: assessment.level,
    acknowledgementRequired: assessment.required,
    ruleSetId: rules.ruleSet.id,
    ruleSetVersion: rules.ruleSet.version,
    band: serializeBand(band, bandCapitalTo(rules, rules.bands.indexOf(band))),
  };
}

// ---------------------------------------------------------------------------
// Disclaimer text
// ---------------------------------------------------------------------------

export interface Disclaimer {
  level: RiskAcknowledgementLevel;
  ruleSetId: string;
  ruleSetVersion: number;
  document: PolicyDocument;
  statement: string;
  statementSha256: string;
}

export async function buildDisclaimer(assessment: Assessment, transaction?: Transaction): Promise<Disclaimer> {
  const level = assessment.required;
  if (!level) throw new Error('buildDisclaimer called for a choice that needs no disclaimer');
  const document = await getCurrentDisclaimerDocument(DISCLAIMER_TYPE_FOR_LEVEL[level], transaction);
  const { segment, band } = assessment;
  const statement = renderTemplate(document.content, {
    segment: segment.name,
    capital: formatAmount(assessment.capital, segment.currency),
    riskPercent: formatPercentText(assessment.riskPercent),
    riskAmount: formatAmount(assessment.riskAmount, segment.currency),
    riskAmountPeriod: riskAmountPeriod(segment.riskBasis),
    minPercent: formatPercentText(band.minRiskPercent),
    suggestedPercent: formatPercentText(band.suggestedRiskPercent),
    maxPercent: formatPercentText(band.maxRiskPercent),
    confirmationPhrase: CONFIRMATION_PHRASE,
  });
  return {
    level,
    ruleSetId: assessment.rules.ruleSet.id,
    ruleSetVersion: assessment.rules.ruleSet.version,
    document,
    statement,
    statementSha256: sha256Hex(statement),
  };
}

export function serializeDisclaimer(disclaimer: Disclaimer) {
  return {
    level: disclaimer.level,
    ruleSetId: disclaimer.ruleSetId,
    ruleSetVersion: disclaimer.ruleSetVersion,
    policyDocumentId: disclaimer.document.id,
    policyVersion: disclaimer.document.version,
    title: disclaimer.document.title,
    statement: disclaimer.statement,
    statementSha256: disclaimer.statementSha256,
    confirmationPhrase: disclaimer.level === 'above_maximum' ? CONFIRMATION_PHRASE : null,
  };
}

export type AcknowledgementProblem = 'missing' | 'outdated' | 'level_mismatch' | 'confirmation_phrase';

export function checkAcknowledgement(
  disclaimer: Disclaimer,
  input: AcknowledgementInput | undefined,
): AcknowledgementProblem | null {
  if (!input) return 'missing';
  if (input.level !== disclaimer.level) return 'level_mismatch';
  if (
    input.ruleSetId !== disclaimer.ruleSetId ||
    input.policyDocumentId !== disclaimer.document.id ||
    input.statementSha256 !== disclaimer.statementSha256
  ) {
    return 'outdated';
  }
  if (disclaimer.level === 'above_maximum' && !matchesConfirmationPhrase(input.typedConfirmation)) {
    return 'confirmation_phrase';
  }
  return null;
}

const PROBLEM_MESSAGES: Record<AcknowledgementProblem, string> = {
  missing: 'Please read and accept the disclaimer for this risk level',
  outdated: 'The risk limits or the disclaimer have changed. Please read the updated disclaimer',
  level_mismatch: 'This risk level needs a different disclaimer. Please read it again',
  confirmation_phrase: `Type "${CONFIRMATION_PHRASE}" to accept a risk above the maximum limit`,
};

function problemDetail(assessment: Assessment, disclaimer: Disclaimer, problem: AcknowledgementProblem): ErrorDetail {
  return {
    path: 'acknowledgement',
    message: `${assessment.segment.name}: ${PROBLEM_MESSAGES[problem]}`,
    segmentId: assessment.segment.id,
    reason: problem,
    level: disclaimer.level,
    disclaimer: serializeDisclaimer(disclaimer),
  };
}

/**
 * True when an earlier acknowledgement still covers the choice: same level,
 * same capital and risk, and the same band values (so the text the user
 * accepted would read the same today).
 */
export function acknowledgementCovers(ack: RiskAcknowledgement | null | undefined, assessment: Assessment): boolean {
  if (!ack || !assessment.required) return false;
  const { band } = assessment;
  return (
    ack.level === assessment.required &&
    ack.segmentId === assessment.segment.id &&
    toDecimal(ack.capital).eq(assessment.capital) &&
    toDecimal(ack.riskPercent).eq(assessment.riskPercent) &&
    toDecimal(ack.bandCapitalFrom).eq(band.capitalFrom) &&
    toDecimal(ack.bandMinPercent).eq(band.minRiskPercent) &&
    toDecimal(ack.bandSuggestedPercent).eq(band.suggestedRiskPercent) &&
    toDecimal(ack.bandMaxPercent).eq(band.maxRiskPercent)
  );
}

export async function loadAcknowledgements(
  ids: (string | null | undefined)[],
  transaction?: Transaction,
): Promise<Map<string, RiskAcknowledgement>> {
  const wanted = [...new Set(ids.filter((id): id is string => typeof id === 'string'))];
  if (wanted.length === 0) return new Map();
  const rows = await RiskAcknowledgement.findAll({ where: { id: { [Op.in]: wanted } }, transaction });
  return new Map(rows.map((row) => [row.id, row]));
}

// ---------------------------------------------------------------------------
// Settling a set of choices
// ---------------------------------------------------------------------------

export interface RiskChoice {
  assessment: Assessment;
  acknowledgement?: AcknowledgementInput | undefined;
  /** An acknowledgement already on record for these values (reused when it still covers them). */
  existing?: RiskAcknowledgement | null | undefined;
  previousCapital?: string | null | undefined;
  previousRiskPercent?: string | null | undefined;
}

export interface SettledChoice extends RiskChoice {
  /** A new acknowledgement to record (the disclaimer that was accepted). */
  accepted: Disclaimer | null;
  /** The existing acknowledgement that still covers the choice. */
  reused: RiskAcknowledgement | null;
}

/**
 * Check every choice that needs a disclaimer. Throws one
 * RISK_ACKNOWLEDGEMENT_REQUIRED listing every segment still owing one (each
 * detail carries the disclaimer to show). Nothing is written here.
 */
export async function settleChoices(choices: RiskChoice[], transaction?: Transaction): Promise<SettledChoice[]> {
  const settled: SettledChoice[] = [];
  const problems: ErrorDetail[] = [];
  for (const choice of choices) {
    const { assessment } = choice;
    if (!assessment.required) {
      settled.push({ ...choice, accepted: null, reused: null });
      continue;
    }
    if (!choice.acknowledgement && acknowledgementCovers(choice.existing, assessment)) {
      settled.push({ ...choice, accepted: null, reused: choice.existing ?? null });
      continue;
    }
    const disclaimer = await buildDisclaimer(assessment, transaction);
    const problem = checkAcknowledgement(disclaimer, choice.acknowledgement);
    if (problem) problems.push(problemDetail(assessment, disclaimer, problem));
    else settled.push({ ...choice, accepted: disclaimer, reused: null });
  }
  if (problems.length > 0) {
    throw AppError.unprocessable(
      'Please accept the disclaimer for each risk level above the suggested limit',
      ErrorCode.RISK_ACKNOWLEDGEMENT_REQUIRED,
      problems,
    );
  }
  return settled;
}

export function serializeAcknowledgement(ack: RiskAcknowledgement) {
  return {
    id: ack.id,
    segmentId: ack.segmentId,
    riskProfileId: ack.riskProfileId,
    ruleSetId: ack.ruleSetId,
    source: ack.source,
    level: ack.level,
    riskBasis: ack.riskBasis,
    currency: ack.currency,
    capital: formatMoney(ack.capital),
    riskPercent: formatPercent(ack.riskPercent),
    riskAmount: formatMoney(ack.riskAmount),
    band: {
      capitalFrom: formatMoney(ack.bandCapitalFrom),
      minRiskPercent: formatPercent(ack.bandMinPercent),
      suggestedRiskPercent: formatPercent(ack.bandSuggestedPercent),
      maxRiskPercent: formatPercent(ack.bandMaxPercent),
    },
    previous: {
      capital: ack.previousCapital === null ? null : formatMoney(ack.previousCapital),
      riskPercent: ack.previousRiskPercent === null ? null : formatPercent(ack.previousRiskPercent),
    },
    policyDocumentId: ack.policyDocumentId,
    policyContentSha256: ack.policyContentSha256,
    statement: ack.statement,
    statementSha256: ack.statementSha256,
    typedConfirmation: ack.typedConfirmation,
    ipAddress: ack.ipAddress,
    userAgent: ack.userAgent,
    createdAt: ack.createdAt,
  };
}

/**
 * Store the acknowledgements accepted in `settled` (one row each, plus an
 * audit entry). Returns segmentId -> acknowledgement id covering the choice,
 * including reused ones.
 */
export async function recordAcknowledgements(
  settled: SettledChoice[],
  params: { userId: string; riskProfileId: string; source: RiskAcknowledgementSource; context: RequestContext },
  transaction: Transaction,
): Promise<Map<string, string>> {
  const covering = new Map<string, string>();
  for (const choice of settled) {
    const { assessment } = choice;
    if (choice.reused) {
      covering.set(assessment.segment.id, choice.reused.id);
      continue;
    }
    const disclaimer = choice.accepted;
    if (!disclaimer) continue;
    const { band, segment } = assessment;
    const ack = await RiskAcknowledgement.create(
      {
        userId: params.userId,
        segmentId: segment.id,
        riskProfileId: params.riskProfileId,
        ruleSetId: disclaimer.ruleSetId,
        source: params.source,
        level: disclaimer.level,
        riskBasis: segment.riskBasis,
        currency: segment.currency,
        capital: assessment.capital,
        riskPercent: assessment.riskPercent,
        riskAmount: assessment.riskAmount,
        bandCapitalFrom: formatMoney(band.capitalFrom),
        bandMinPercent: formatPercent(band.minRiskPercent),
        bandSuggestedPercent: formatPercent(band.suggestedRiskPercent),
        bandMaxPercent: formatPercent(band.maxRiskPercent),
        previousCapital: choice.previousCapital ? formatMoney(choice.previousCapital) : null,
        previousRiskPercent: choice.previousRiskPercent ? formatPercent(choice.previousRiskPercent) : null,
        policyDocumentId: disclaimer.document.id,
        policyContentSha256: disclaimer.document.contentSha256,
        statement: disclaimer.statement,
        statementSha256: disclaimer.statementSha256,
        typedConfirmation:
          disclaimer.level === 'above_maximum' ? normalisePhrase(choice.acknowledgement?.typedConfirmation ?? '') : null,
        ipAddress: params.context.ipAddress,
        userAgent: params.context.userAgent,
        requestId: params.context.requestId,
      },
      { transaction },
    );
    covering.set(segment.id, ack.id);

    await recordAudit(
      {
        actor: { type: 'user', id: params.userId },
        action: AuditAction.RISK_ACKNOWLEDGED,
        entityType: 'risk_acknowledgement',
        entityId: ack.id,
        subjectUserId: params.userId,
        severity: disclaimer.level === 'above_maximum' ? 'warning' : 'info',
        before: { capital: ack.previousCapital, riskPercent: ack.previousRiskPercent },
        after: {
          segment: segment.code,
          source: params.source,
          level: ack.level,
          capital: ack.capital,
          riskPercent: ack.riskPercent,
          riskAmount: ack.riskAmount,
          band: {
            capitalFrom: ack.bandCapitalFrom,
            minRiskPercent: ack.bandMinPercent,
            suggestedRiskPercent: ack.bandSuggestedPercent,
            maxRiskPercent: ack.bandMaxPercent,
          },
          ruleSetVersion: disclaimer.ruleSetVersion,
          disclaimer: { id: disclaimer.document.id, version: disclaimer.document.version },
          statementSha256: ack.statementSha256,
        },
        context: params.context,
      },
      transaction,
    );
  }
  return covering;
}
