import { randomBytes, timingSafeEqual } from 'node:crypto';
import { argon2id } from 'hash-wasm';

export interface PasswordParams {
  memoryCostKib: number;
  timeCost: number;
  parallelism: number;
  hashLengthBytes: number;
}

// Same OWASP-minimum Argon2id floor already enforced for the screen-lock
// PIN (securityLockService.ts), applied server-side since - unlike the
// PIN - the raw password does have to reach the server to be checked
// against a stored credential at all.
export const DEFAULT_PASSWORD_PARAMS: PasswordParams = {
  memoryCostKib: 19_456,
  timeCost: 3,
  parallelism: 1,
  hashLengthBytes: 32,
};

export interface StoredPasswordCredential {
  hash: string;
  salt: string;
  params: PasswordParams;
}

export class WeakPasswordError extends Error {}

export function validatePasswordStrength(password: string): void {
  if (password.length < 8) {
    throw new WeakPasswordError('Password must be at least 8 characters long.');
  }
  if (password.length > 200) {
    throw new WeakPasswordError('Password is too long.');
  }
}

export async function hashPassword(password: string): Promise<StoredPasswordCredential> {
  const salt = randomBytes(16).toString('hex');
  const params = DEFAULT_PASSWORD_PARAMS;
  const hash = await argon2id({
    password,
    salt,
    iterations: params.timeCost,
    parallelism: params.parallelism,
    memorySize: params.memoryCostKib,
    hashLength: params.hashLengthBytes,
    outputType: 'hex',
  });
  return { hash, salt, params };
}

export async function verifyPassword(password: string, stored: StoredPasswordCredential): Promise<boolean> {
  const candidate = await argon2id({
    password,
    salt: stored.salt,
    iterations: stored.params.timeCost,
    parallelism: stored.params.parallelism,
    memorySize: stored.params.memoryCostKib,
    hashLength: stored.params.hashLengthBytes,
    outputType: 'hex',
  });
  return hashesMatch(stored.hash, candidate);
}

/** Constant-time hex-hash comparison. Mismatched lengths (malformed input) fail closed without throwing. */
function hashesMatch(stored: string, submitted: string): boolean {
  try {
    const a = Buffer.from(stored, 'hex');
    const b = Buffer.from(submitted, 'hex');
    if (a.length === 0 || a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
