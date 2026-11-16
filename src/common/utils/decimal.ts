import { Decimal } from 'decimal.js';

/**
 * Exact decimal arithmetic for money and percentages. JavaScript numbers are
 * never used for financial values: PostgreSQL NUMERIC columns arrive as
 * strings, are compared/computed with Decimal, and leave as fixed-scale
 * strings.
 */
const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

export type DecimalValue = InstanceType<typeof D>;

export const MONEY_SCALE = 2;
export const PERCENT_SCALE = 4;

export function toDecimal(value: string | number): DecimalValue {
  return new D(value);
}

/** "150000" -> "150000.00" */
export function formatMoney(value: string | DecimalValue): string {
  return new D(value).toFixed(MONEY_SCALE);
}

/** "2.5" -> "2.5000" */
export function formatPercent(value: string | DecimalValue): string {
  return new D(value).toFixed(PERCENT_SCALE);
}

/** Number of digits after the decimal point in a canonical decimal string. */
export function decimalPlaces(value: string): number {
  return new D(value).decimalPlaces();
}
