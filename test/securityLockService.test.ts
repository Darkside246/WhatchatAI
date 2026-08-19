import { beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import {
  attemptUnlock,
  getLockStatus,
  getUnlockChallenge,
  setupLock,
  InvalidArgon2ParamsError,
  LockAlreadyConfiguredError,
  LockNotConfiguredError,
} from '../src/services/securityLockService.js';
import { SecurityAuditLogRepository } from '../src/repositories/securityAuditLogRepository.js';
import { createTestBusiness, resetDatabase } from './helpers.js';

const VALID_ARGON2_PARAMS = { memoryCostKib: 19_456, timeCost: 2, parallelism: 1, hashLengthBytes: 32 };
const CORRECT_HASH = 'a'.repeat(64);
const WRONG_HASH = 'b'.repeat(64);

describe('securityLockService (real Postgres-backed Argon2id PIN lock)', () => {
  let businessId: string;

  beforeEach(async () => {
    await resetDatabase();
    businessId = await createTestBusiness();
  });

  it('reports not configured before setup, configured after', async () => {
    expect(await getLockStatus(businessId)).toEqual({ configured: false });

    await setupLock(businessId, { salt: 'a'.repeat(32), pinHash: CORRECT_HASH, argon2Params: VALID_ARGON2_PARAMS });

    expect(await getLockStatus(businessId)).toEqual({ configured: true });
  });

  it('rejects a second setup for the same business', async () => {
    await setupLock(businessId, { salt: 'a'.repeat(32), pinHash: CORRECT_HASH, argon2Params: VALID_ARGON2_PARAMS });
    await expect(
      setupLock(businessId, { salt: 'c'.repeat(32), pinHash: WRONG_HASH, argon2Params: VALID_ARGON2_PARAMS }),
    ).rejects.toThrow(LockAlreadyConfiguredError);
  });

  it('rejects Argon2id parameters below the OWASP-minimum security bar', async () => {
    await expect(
      setupLock(businessId, {
        salt: 'a'.repeat(32),
        pinHash: CORRECT_HASH,
        argon2Params: { memoryCostKib: 1024, timeCost: 1, parallelism: 1, hashLengthBytes: 8 },
      }),
    ).rejects.toThrow(InvalidArgon2ParamsError);
  });

  it('serves the real stored salt and params as the unlock challenge', async () => {
    await expect(getUnlockChallenge(businessId)).rejects.toThrow(LockNotConfiguredError);

    await setupLock(businessId, { salt: 'deadbeef'.repeat(4), pinHash: CORRECT_HASH, argon2Params: VALID_ARGON2_PARAMS });
    const challenge = await getUnlockChallenge(businessId);
    expect(challenge.salt).toBe('deadbeef'.repeat(4));
    expect(challenge.argon2Params).toEqual(VALID_ARGON2_PARAMS);
  });

  it('unlocks on a matching hash and records a real audit event', async () => {
    await setupLock(businessId, { salt: 'a'.repeat(32), pinHash: CORRECT_HASH, argon2Params: VALID_ARGON2_PARAMS });

    const result = await attemptUnlock(businessId, CORRECT_HASH);
    expect(result).toEqual({ unlocked: true, revoked: false, remainingAttempts: null });

    const auditLog = new SecurityAuditLogRepository(pool);
    const recent = await auditLog.listRecent(businessId, 5);
    expect(recent[0]?.eventType).toBe('lock_unlock_success');
  });

  it('fails on a mismatched hash and reports remaining attempts', async () => {
    await setupLock(businessId, { salt: 'a'.repeat(32), pinHash: CORRECT_HASH, argon2Params: VALID_ARGON2_PARAMS });

    const result = await attemptUnlock(businessId, WRONG_HASH);
    expect(result).toEqual({ unlocked: false, revoked: false, remainingAttempts: 9 });
  });

  it('revokes the lock after 10 consecutive failed attempts and permanently throttles further attempts', async () => {
    await setupLock(businessId, { salt: 'a'.repeat(32), pinHash: CORRECT_HASH, argon2Params: VALID_ARGON2_PARAMS });

    let lastResult;
    for (let i = 0; i < 10; i += 1) {
      lastResult = await attemptUnlock(businessId, WRONG_HASH);
    }
    expect(lastResult).toEqual({ unlocked: false, revoked: true, remainingAttempts: 0 });

    const auditLog = new SecurityAuditLogRepository(pool);
    const recent = await auditLog.listRecent(businessId, 15);
    expect(recent[0]?.eventType).toBe('lock_revoked');
    expect(recent[0]?.severity).toBe('critical');

    // Even the CORRECT hash must not unlock once revoked - real re-authentication is out of scope until a session/auth system exists.
    const afterRevoke = await attemptUnlock(businessId, CORRECT_HASH);
    expect(afterRevoke).toEqual({ unlocked: false, revoked: true, remainingAttempts: 0 });

    const recentAfter = await auditLog.listRecent(businessId, 1);
    expect(recentAfter[0]?.eventType).toBe('lock_throttled');
  });
});
