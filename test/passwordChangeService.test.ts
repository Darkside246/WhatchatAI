import { beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { register, login, validateSession, isInvalidCredentialsError, isWeakPasswordError } from '../src/services/authService.js';
import { changePassword, SamePasswordError } from '../src/services/passwordChangeService.js';
import { SecurityAuditLogRepository } from '../src/repositories/securityAuditLogRepository.js';
import { resetDatabase } from './helpers.js';

const device = { ipAddress: '127.0.0.1', userAgent: 'vitest-agent' };
const ORIGINAL = 'correcthorsebatterystaple';

/**
 * AURA had no way to change a password at all before this - no endpoint, no
 * screen. Every password it ever set was permanent until someone with
 * database access ran the admin recovery script again, which meant a
 * password handed to a customer stayed theirs forever.
 */
describe('changePassword (real Postgres, real Argon2 credentials)', () => {
  let businessId: string;
  let userId: string;
  let sessionId: string;

  beforeEach(async () => {
    await resetDatabase();
    const registered = await register({ email: 'owner@example.com', password: ORIGINAL, displayName: 'Owner' }, device);
    businessId = registered.business.id;
    userId = registered.user.id;
    sessionId = registered.session.id;
  });

  it('replaces the credential, so the new password works and the old one does not', async () => {
    await changePassword(businessId, userId, ORIGINAL, 'a-much-better-password', sessionId);

    const signedIn = await login('owner@example.com', 'a-much-better-password', device);
    expect(signedIn.user.id).toBe(userId);

    await expect(login('owner@example.com', ORIGINAL, device)).rejects.toSatisfy(isInvalidCredentialsError);
  });

  /**
   * The point of the whole feature. A new credential evicts nobody on its
   * own - tokens issued before the change stay valid until they expire - so
   * changing a password you believe is compromised would look like it had
   * secured the account without having done so.
   */
  it('signs out every other device, and keeps the one being used', async () => {
    // A DIFFERENT device on purpose. Signing in again from the same
    // ip/user-agent pair is treated as a re-login and revokes the earlier
    // session by itself (revokeMatchingDeviceForUser), which would leave
    // nothing for this test to actually prove.
    const elsewhere = await login('owner@example.com', ORIGINAL, { ipAddress: '10.0.0.9', userAgent: 'another-device' });
    expect(await validateSession(elsewhere.token)).not.toBeNull();

    const { otherSessionsRevoked } = await changePassword(businessId, userId, ORIGINAL, 'a-much-better-password', sessionId);

    expect(otherSessionsRevoked).toBe(1);
    expect(await validateSession(elsewhere.token)).toBeNull();
    // Signing someone out of the screen they are standing at, as a reward
    // for improving their security, teaches them not to do it again.
    const { rows } = await pool.query<{ revoked_at: string | null }>('SELECT revoked_at FROM sessions WHERE id = $1', [sessionId]);
    expect(rows[0]?.revoked_at).toBeNull();
  });

  describe('refuses', () => {
    it('a wrong current password, without changing anything', async () => {
      await expect(changePassword(businessId, userId, 'not-my-password', 'a-much-better-password', sessionId)).rejects.toSatisfy(
        isInvalidCredentialsError,
      );

      // Still the original - a failed attempt must not half-apply.
      const stillWorks = await login('owner@example.com', ORIGINAL, device);
      expect(stillWorks.user.id).toBe(userId);
    });

    it('a new password that is the same as the current one', async () => {
      // Refused rather than accepted as a no-op: someone doing this has a
      // reason, and "saved" on a change that changed nothing would say a
      // problem was dealt with when it was not.
      await expect(changePassword(businessId, userId, ORIGINAL, ORIGINAL, sessionId)).rejects.toThrow(SamePasswordError);
    });

    it('a new password that does not meet the policy', async () => {
      await expect(changePassword(businessId, userId, ORIGINAL, 'short', sessionId)).rejects.toSatisfy(isWeakPasswordError);

      // And the account is untouched.
      const stillWorks = await login('owner@example.com', ORIGINAL, device);
      expect(stillWorks.user.id).toBe(userId);
    });
  });

  it('records a real audit event carrying the fact and not the password', async () => {
    await changePassword(businessId, userId, ORIGINAL, 'a-much-better-password', sessionId);

    const events = await new SecurityAuditLogRepository(pool).listRecent(businessId);
    const event = events.find((candidate) => candidate.eventType === 'password_changed');
    expect(event).toBeDefined();
    const serialised = JSON.stringify(event);
    expect(serialised).not.toContain('a-much-better-password');
    expect(serialised).not.toContain(ORIGINAL);
  });
});
