import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

/** URL-safe opaque token with `bytes` of entropy (default 256 bits). */
export function generateOpaqueToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Hex SHA-256. Suitable for hashing high-entropy tokens before storage. */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Hex HMAC-SHA256 with a server-side secret. Used for low-entropy secrets such
 * as 6-digit OTPs: a stolen database dump cannot be brute-forced offline
 * without the key.
 */
export function hmacSha256Hex(secret: string, value: string): string {
  return createHmac('sha256', secret).update(value, 'utf8').digest('hex');
}

/** Constant-time comparison of two equal-format hex digests. */
export function safeEqualHex(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  if (left.length !== right.length || left.length === 0) return false;
  return timingSafeEqual(left, right);
}

// Characters that are easy to tell apart when read off a screen: no 0/O, 1/l/I.
const PASSWORD_UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const PASSWORD_LOWER = 'abcdefghjkmnpqrstuvwxyz';
const PASSWORD_DIGITS = '23456789';
const PASSWORD_SYMBOLS = '@#$%&*?';

const pick = (alphabet: string): string => alphabet.charAt(randomInt(0, alphabet.length));

/**
 * A random temporary password from the operating system's secure generator
 * (crypto.randomInt, no modulo bias). Always contains an upper-case letter, a
 * lower-case letter, a digit and a symbol, so it meets the password policy.
 */
export function generateTemporaryPassword(length = 16): string {
  const all = PASSWORD_UPPER + PASSWORD_LOWER + PASSWORD_DIGITS + PASSWORD_SYMBOLS;
  const chars = [pick(PASSWORD_UPPER), pick(PASSWORD_LOWER), pick(PASSWORD_DIGITS), pick(PASSWORD_SYMBOLS)];
  while (chars.length < length) chars.push(pick(all));
  // Fisher-Yates shuffle so the guaranteed characters are not always first.
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = randomInt(0, i + 1);
    [chars[i], chars[j]] = [chars[j] as string, chars[i] as string];
  }
  return chars.join('');
}

/** Uniformly distributed numeric code (crypto.randomInt has no modulo bias). */
export function generateNumericCode(length = 6): string {
  let code = '';
  for (let i = 0; i < length; i += 1) {
    code += randomInt(0, 10).toString();
  }
  return code;
}
