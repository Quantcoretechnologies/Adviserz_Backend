import argon2 from 'argon2';

/**
 * Argon2id with OWASP-recommended minimum parameters
 * (m = 19 MiB, t = 2, p = 1). Parameters are encoded in each hash, so they can
 * be raised later; `needsRehash` reports hashes created with weaker settings.
 */
const HASH_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export async function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, HASH_OPTIONS);
}

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    // Malformed hash — treat as a mismatch rather than a server error.
    return false;
  }
}

export function passwordNeedsRehash(hash: string): boolean {
  return argon2.needsRehash(hash, HASH_OPTIONS);
}

/**
 * Hash used to equalise response time when an account does not exist, so the
 * login endpoint does not reveal which identifiers are registered.
 */
let dummyHashPromise: Promise<string> | undefined;

export async function burnPasswordVerification(plain: string): Promise<void> {
  dummyHashPromise ??= hashPassword('dummy-password-for-timing-equalisation');
  await verifyPassword(await dummyHashPromise, plain);
}
