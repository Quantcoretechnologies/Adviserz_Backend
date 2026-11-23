import type { Transaction } from 'sequelize';
import { AppError } from '../../common/errors/AppError.js';
import { ErrorCode } from '../../common/errors/errorCodes.js';
import { toDecimal } from '../../common/utils/decimal.js';
import { PolicyDocument } from '../../models/index.js';
import type { DisclaimerPolicyType, RiskAcknowledgementLevel, RiskBasis } from '../../models/enums.js';

/**
 * Disclaimer texts are versioned policy documents (published from the admin
 * console like the Terms). Their content is a template: `{{name}}`
 * placeholders are filled with the user's own numbers, and the filled-in text
 * is what the user sees and what is stored with the acknowledgement.
 *
 * Template layout, understood by the apps: paragraphs separated by a blank
 * line; numbered lines ("1. ...") form a list; a final paragraph starting with
 * "Declaration:" is the sentence the user ticks.
 */

export const DISCLAIMER_TYPE_FOR_LEVEL: Record<RiskAcknowledgementLevel, DisclaimerPolicyType> = {
  above_suggested: 'risk_disclaimer_above_suggested',
  above_maximum: 'risk_disclaimer_above_maximum',
};

/** Typed by the user to accept the strict (above maximum) disclaimer. */
export const CONFIRMATION_PHRASE = 'I ACCEPT THE RISK';

/** Case, surrounding spaces and repeated spaces do not matter. */
export function matchesConfirmationPhrase(input: string | null | undefined): boolean {
  return normalisePhrase(input ?? '') === CONFIRMATION_PHRASE;
}

export function normalisePhrase(input: string): string {
  return input.trim().replace(/\s+/g, ' ').toUpperCase();
}

/**
 * Placeholders each disclaimer template must contain, checked when an admin
 * saves a draft, so a new version can never drop the user's numbers.
 */
export const REQUIRED_PLACEHOLDERS: Record<DisclaimerPolicyType, readonly string[]> = {
  risk_disclaimer_above_suggested: ['segment', 'capital', 'riskPercent', 'riskAmount', 'suggestedPercent'],
  risk_disclaimer_above_maximum: ['segment', 'capital', 'riskPercent', 'riskAmount', 'maxPercent'],
  risk_limits_change_notice: ['changes'],
};

export function missingPlaceholders(type: DisclaimerPolicyType, content: string): string[] {
  return REQUIRED_PLACEHOLDERS[type].filter((name) => !content.includes(`{{${name}}}`));
}

/** The current (highest published) version of a disclaimer text. */
export async function getCurrentDisclaimerDocument(
  type: DisclaimerPolicyType,
  transaction?: Transaction,
): Promise<PolicyDocument> {
  const doc = await PolicyDocument.findOne({
    where: { type, status: 'published' },
    order: [['version', 'DESC']],
    transaction,
  });
  if (!doc) {
    throw new AppError(
      503,
      ErrorCode.RISK_DISCLAIMER_UNAVAILABLE,
      'This risk level cannot be accepted right now. Please try again later',
    );
  }
  return doc;
}

/** Fill `{{name}}` placeholders; unknown names are left as they are. */
export function renderTemplate(content: string, values: Record<string, string>): string {
  return content
    .replace(/\{\{\s*([a-zA-Z]+)\s*\}\}/g, (match, name: string) => values[name] ?? match)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---------------------------------------------------------------------------
// Formatting for display
// ---------------------------------------------------------------------------

/** Indian digit grouping: 1234567.5 -> "12,34,567.50"; whole amounts drop ".00". */
function groupIndian(value: string): string {
  const fixed = toDecimal(value).toFixed(2);
  const negative = fixed.startsWith('-');
  const [whole = '0', paise = '00'] = (negative ? fixed.slice(1) : fixed).split('.');
  const lastThree = whole.slice(-3);
  const rest = whole.slice(0, -3);
  const grouped = rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${lastThree}` : lastThree;
  return `${negative ? '-' : ''}${grouped}${paise === '00' ? '' : `.${paise}`}`;
}

export function formatAmount(value: string, currency: string): string {
  return currency === 'INR' ? `₹${groupIndian(value)}` : `${currency} ${groupIndian(value)}`;
}

/** "7.5000" -> "7.5%" */
export function formatPercentText(value: string): string {
  return `${toDecimal(value).toString()}%`;
}

export function riskAmountPeriod(riskBasis: RiskBasis): string {
  return riskBasis === 'daily_loss' ? 'per day' : 'of capital';
}
