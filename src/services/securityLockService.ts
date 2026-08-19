import { timingSafeEqual } from 'node:crypto';
import { pool } from '../db/pool.js';
import { SecurityLockCredentialRepository, type Argon2Params } from '../repositories/securityLockCredentialRepository.js';
import { SecurityAuditLogRepository } from '../repositories/securityAuditLogRepository.js';

const MAX_FAILED_ATTEMPTS = 10;
// OWASP-minimum Argon2id parameters. The client picks its own (stronger)
// defaults; this only rejects a setup request weak enough to be unsafe.
const MIN_MEMORY_COST_KIB = 19_456;
const MIN_TIME_COST = 2;
const MIN_PARALLELISM = 1;
const MIN_HASH_LENGTH_BYTES = 16;

export class InvalidArgon2ParamsError extends Error {}
export class LockAlreadyConfiguredError extends Error {}
export class LockNotConfiguredError extends Error {}

export interface LockStatus {
  configured: boolean;
}

export interface UnlockChallenge {
  salt: string;
  argon2Params: Argon2Params;
}

export interface SetupLockInput {
  salt: string;
  pinHash: string;
  argon2Params: Argon2Params;
}

export interface UnlockResult {
  unlocked: boolean;
  revoked: boolean;
  remainingAttempts: number | null;
}

function validateArgon2Params(params: Argon2Params): void {
  if (
    !Number.isFinite(params.memoryCostKib) ||
    !Number.isFinite(params.timeCost) ||
    !Number.isFinite(params.parallelism) ||
    !Number.isFinite(params.hashLengthBytes) ||
    params.memoryCostKib < MIN_MEMORY_COST_KIB ||
    params.timeCost < MIN_TIME_COST ||
    params.parallelism < MIN_PARALLELISM ||
    params.hashLengthBytes < MIN_HASH_LENGTH_BYTES
  ) {
    throw new InvalidArgon2ParamsError('Argon2id parameters do not meet the minimum security bar.');
  }
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

export async function getLockStatus(businessId: string): Promise<LockStatus> {
  const repo = new SecurityLockCredentialRepository(pool);
  const credential = await repo.findByBusiness(businessId);
  return { configured: Boolean(credential) };
}

export async function getUnlockChallenge(businessId: string): Promise<UnlockChallenge> {
  const repo = new SecurityLockCredentialRepository(pool);
  const credential = await repo.findByBusiness(businessId);
  if (!credential) throw new LockNotConfiguredError('No PIN has been configured for this business yet.');
  return { salt: credential.pinSalt, argon2Params: credential.argon2Params };
}

/** The server only ever receives an already-Argon2id-hashed PIN, never the raw digits. */
export async function setupLock(businessId: string, input: SetupLockInput): Promise<void> {
  validateArgon2Params(input.argon2Params);

  const repo = new SecurityLockCredentialRepository(pool);
  const auditLog = new SecurityAuditLogRepository(pool);

  const created = await repo.createIfAbsent(businessId, input.salt, input.pinHash, input.argon2Params);
  if (!created) throw new LockAlreadyConfiguredError('A PIN is already configured for this business.');

  await auditLog.record({ businessId, eventType: 'lock_setup', severity: 'info', rawMetadata: {} });
}

/**
 * Walks the audit log backwards from most recent to count consecutive
 * unlock failures since the last success/setup, and detects whether the
 * lock is already in a revoked state. Reuses security_audit_logs as the
 * source of truth instead of adding new mutable counter columns.
 */
async function getFailureState(businessId: string): Promise<{ consecutiveFailures: number; revoked: boolean }> {
  const auditLog = new SecurityAuditLogRepository(pool);
  const recent = await auditLog.listRecent(businessId, 100);

  let consecutiveFailures = 0;
  for (const event of recent) {
    if (event.eventType === 'lock_unlock_failure') {
      consecutiveFailures += 1;
      continue;
    }
    if (event.eventType === 'lock_revoked') {
      return { consecutiveFailures, revoked: true };
    }
    if (event.eventType === 'lock_unlock_success' || event.eventType === 'lock_setup') {
      break;
    }
    // Other event types (e.g. lock_throttled, sentinel_*) don't affect the streak.
  }
  return { consecutiveFailures, revoked: false };
}

/**
 * Full forced re-login on revocation isn't wired here: this codebase has no
 * session/auth system yet (deferred). What's real is the state transition
 * itself - a persisted, audited lock_revoked event that permanently blocks
 * further unlock attempts until a real auth layer adds PIN reset.
 */
export async function attemptUnlock(businessId: string, pinHash: string): Promise<UnlockResult> {
  const repo = new SecurityLockCredentialRepository(pool);
  const auditLog = new SecurityAuditLogRepository(pool);

  const { consecutiveFailures, revoked } = await getFailureState(businessId);
  if (revoked) {
    await auditLog.record({
      businessId,
      eventType: 'lock_throttled',
      severity: 'warning',
      reason: 'Unlock attempted after the lock was already revoked.',
    });
    return { unlocked: false, revoked: true, remainingAttempts: 0 };
  }

  const credential = await repo.findByBusiness(businessId);
  if (!credential) throw new LockNotConfiguredError('No PIN has been configured for this business yet.');

  if (hashesMatch(credential.pinHash, pinHash)) {
    await auditLog.record({ businessId, eventType: 'lock_unlock_success', severity: 'info' });
    return { unlocked: true, revoked: false, remainingAttempts: null };
  }

  await auditLog.record({ businessId, eventType: 'lock_unlock_failure', severity: 'warning' });
  const failuresAfter = consecutiveFailures + 1;

  if (failuresAfter >= MAX_FAILED_ATTEMPTS) {
    await auditLog.record({
      businessId,
      eventType: 'lock_revoked',
      severity: 'critical',
      reason: `${failuresAfter} consecutive failed unlock attempts`,
    });
    return { unlocked: false, revoked: true, remainingAttempts: 0 };
  }

  return { unlocked: false, revoked: false, remainingAttempts: MAX_FAILED_ATTEMPTS - failuresAfter };
}
