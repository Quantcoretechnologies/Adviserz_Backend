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

/** Uniformly distributed numeric code (crypto.randomInt has no modulo bias). */
export function generateNumericCode(length = 6): string {
  let code = '';
  for (let i = 0; i < length; i += 1) {
    code += randomInt(0, 10).toString();
  }
  return code;
}
