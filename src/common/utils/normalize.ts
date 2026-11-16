/**
 * Canonical forms for identifiers. Every write and every lookup goes through
 * these functions so uniqueness checks and DB constraints always agree.
 */

/** Lower-cased, trimmed email. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Ten-digit Indian mobile number, first digit 6-9. */
export const INDIAN_MOBILE_REGEX = /^[6-9]\d{9}$/;

/**
 * Accepts "9876543210", "+919876543210" or "919876543210" (spaces/dashes
 * ignored) and returns E.164 "+919876543210". Returns null if invalid.
 */
export function normalizeIndianPhone(input: string): string | null {
  const compact = input.replace(/[\s-]/g, '');
  const match = /^(?:\+?91)?([6-9]\d{9})$/.exec(compact);
  return match?.[1] ? `+91${match[1]}` : null;
}

export function maskEmail(email: string): string {
  const [local = '', domain = ''] = email.split('@');
  const visible = local.slice(0, Math.min(2, local.length));
  return `${visible}${'*'.repeat(Math.max(local.length - visible.length, 1))}@${domain}`;
}

export function maskPhone(phone: string): string {
  return `${phone.slice(0, 3)}******${phone.slice(-4)}`;
}

/** Truncate untrusted header values to fit their column. */
export function truncate(value: string | undefined | null, max: number): string | null {
  if (!value) return null;
  return value.length > max ? value.slice(0, max) : value;
}
