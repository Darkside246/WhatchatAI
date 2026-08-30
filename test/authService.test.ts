import { beforeEach, describe, expect, it } from 'vitest';
import {
  isRegistrationOpen,
  register,
  login,
  logout,
  validateSession,
  listSessions,
  revokeSession,
  renameSession,
  revokeOtherSessions,
  isRegistrationClosedError,
  isInvalidCredentialsError,
  isRateLimitedError,
  isWeakPasswordError,
  isSessionNotFoundError,
} from '../src/services/authService.js';
import { createMember } from '../src/services/workspaceMemberService.js';
import { hashPassword } from '../src/services/passwordHashService.js';
import { pool } from '../src/db/pool.js';
import { resetDatabase, createTestBusiness } from './helpers.js';

const device = { ipAddress: '127.0.0.1', userAgent: 'vitest-agent' };

/**
 * A second real business with a real, known-password login - createTestUser()
 * in helpers.ts deliberately uses a fixture (non-verifiable) password hash,
 * which is fine for tests that never call login(), but useless here.
 */
async function createLoginableUser(businessId: string, email: string, password: string): Promise<void> {
  const credential = await hashPassword(password);
  await pool.query(
    `INSERT INTO users (email, display_name, password_hash, password_salt, password_params)
     VALUES ($1, 'Second Owner', $2, $3, $4)`,
    [email, credential.hash, credential.salt, JSON.stringify(credential.params)],
  );
  const { rows } = await pool.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [email]);
  await pool.query(`INSERT INTO business_memberships (business_id, user_id, role, status) VALUES ($1, $2, 'OWNER', 'active')`, [
    businessId,
    rows[0]!.id,
  ]);
}

describe('authService.register (the real one-time first-user bootstrap)', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('is open when the business has zero members, and closes after the first registration', async () => {
    expect(await isRegistrationOpen()).toBe(true);

    const result = await register({ email: 'owner@example.com', password: 'correcthorsebatterystaple', displayName: 'Owner' }, device);
    expect(result.membership.role).toBe('OWNER');
    expect(result.token).toBeTruthy();

    expect(await isRegistrationOpen()).toBe(false);
  });

  it('rejects a second self-registration once a business already has a member - no open signup into an existing tenant', async () => {
    await register({ email: 'owner@example.com', password: 'correcthorsebatterystaple', displayName: 'Owner' }, device);

    await expect(
      register({ email: 'intruder@example.com', password: 'correcthorsebatterystaple', displayName: 'Intruder' }, device),
    ).rejects.toThrow();
    try {
      await register({ email: 'intruder@example.com', password: 'correcthorsebatterystaple', displayName: 'Intruder' }, device);
      expect.fail('expected register to reject');
    } catch (error) {
      expect(isRegistrationClosedError(error)).toBe(true);
    }
  });

  it('rejects a weak password before ever touching the database', async () => {
    await expect(register({ email: 'owner@example.com', password: 'short', displayName: 'Owner' }, device)).rejects.toThrow();
    try {
      await register({ email: 'owner@example.com', password: 'short', displayName: 'Owner' }, device);
    } catch (error) {
      expect(isWeakPasswordError(error)).toBe(true);
    }
    expect(await isRegistrationOpen()).toBe(true);
  });
});

describe('authService.login - multi-tenant business resolution', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('resolves the caller\'s OWN business, not whichever business happens to sort first - the real fix for a cross-tenant leak that was invisible with only one business in the system', async () => {
    // Business A is created first (sorts first by created_at) - the bug
    // this guards against silently returned Business A's data to a user
    // who actually belongs to Business B, via ensureDefaultBusinessProvisioned()
    // ("the first row in the table") instead of the caller's own membership.
    const businessA = await createTestBusiness('Business A');
    await createLoginableUser(businessA, 'owner-a@example.com', 'correcthorsebatterystaple');

    const businessB = await createTestBusiness('Business B');
    await createLoginableUser(businessB, 'owner-b@example.com', 'correcthorsebatterystaple');

    const result = await login('owner-b@example.com', 'correcthorsebatterystaple', device);

    expect(result.business.id).toBe(businessB);
    expect(result.business.name).toBe('Business B');
    expect(result.business.id).not.toBe(businessA);
  });
});

describe('authService.login / validateSession / logout (real, persistent, revocable sessions)', () => {
  beforeEach(async () => {
    await resetDatabase();
    await register({ email: 'owner@example.com', password: 'correcthorsebatterystaple', displayName: 'Owner' }, device);
  });

  it('logs in with correct credentials and returns a token that validates to the real user', async () => {
    const result = await login('owner@example.com', 'correcthorsebatterystaple', device);
    expect(result.user.email).toBe('owner@example.com');

    const validated = await validateSession(result.token);
    expect(validated?.user.email).toBe('owner@example.com');
    expect(validated?.membership.role).toBe('OWNER');
  });

  it('rejects the wrong password with the same generic message as an unknown email - never leaks which one was wrong', async () => {
    await expect(login('owner@example.com', 'wrong-password', device)).rejects.toThrow();
    await expect(login('nobody@example.com', 'correcthorsebatterystaple', device)).rejects.toThrow();
    try {
      await login('owner@example.com', 'wrong-password', device);
    } catch (error) {
      expect(isInvalidCredentialsError(error)).toBe(true);
    }
  });

  it('rate-limits after repeated failures against the same email', async () => {
    for (let i = 0; i < 8; i += 1) {
      await expect(login('owner@example.com', 'wrong-password', device)).rejects.toThrow();
    }
    try {
      await login('owner@example.com', 'correcthorsebatterystaple', device);
      expect.fail('expected login to reject once rate-limited, even with the correct password');
    } catch (error) {
      expect(isRateLimitedError(error)).toBe(true);
    }
  });

  it('a garbage or expired token never validates', async () => {
    expect(await validateSession('not-a-real-token')).toBeNull();
  });

  it('logout revokes the session - it stops validating immediately after', async () => {
    const result = await login('owner@example.com', 'correcthorsebatterystaple', device);
    expect(await validateSession(result.token)).not.toBeNull();

    await logout(result.token);
    expect(await validateSession(result.token)).toBeNull();
  });
});

describe('authService session management (list/revoke - real device-level control)', () => {
  beforeEach(async () => {
    await resetDatabase();
    await register({ email: 'owner@example.com', password: 'correcthorsebatterystaple', displayName: 'Owner' }, device);
  });

  it('lists every active session for a user, marking exactly one as current', async () => {
    // beforeEach's register() call already created one session of its own -
    // real registration, not a stub, so it counts.
    const first = await login('owner@example.com', 'correcthorsebatterystaple', { ipAddress: '10.0.0.1', userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0 Safari/537.36' });
    const second = await login('owner@example.com', 'correcthorsebatterystaple', { ipAddress: '10.0.0.2', userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) CriOS/120.0' });

    const validated = await validateSession(first.token);
    const sessions = await listSessions(validated!.user.id, first.session.id);
    expect(sessions).toHaveLength(3);
    expect(sessions.find((s) => s.isCurrent)?.id).toBe(first.session.id);
    expect(sessions.map((s) => s.id)).toContain(second.session.id);
    // A real, honest device parse - not a fabricated name.
    expect(sessions.some((s) => s.browser === 'Chrome' && s.os === 'Windows')).toBe(true);
  });

  it('revoking one session does not affect the others, and a foreign session id is rejected', async () => {
    // Genuinely distinct devices - same-device re-logins are now
    // auto-deduped (see the dedicated describe block below), so two
    // sessions meant to coexist for this test need different fingerprints.
    const first = await login('owner@example.com', 'correcthorsebatterystaple', { ipAddress: '10.0.0.1', userAgent: 'device-a' });
    const second = await login('owner@example.com', 'correcthorsebatterystaple', { ipAddress: '10.0.0.2', userAgent: 'device-b' });
    const validated = await validateSession(first.token);

    await revokeSession(validated!.user.id, second.session.id);
    expect(await validateSession(second.token)).toBeNull();
    expect(await validateSession(first.token)).not.toBeNull();

    await expect(revokeSession(validated!.user.id, '00000000-0000-0000-0000-000000000000')).rejects.toThrow();
    try {
      await revokeSession(validated!.user.id, '00000000-0000-0000-0000-000000000000');
    } catch (error) {
      expect(isSessionNotFoundError(error)).toBe(true);
    }
  });

  it('cannot revoke a different user\'s session - real per-user ownership check, not just per-business', async () => {
    const ownerLogin = await login('owner@example.com', 'correcthorsebatterystaple', device);
    const ownerSession = await validateSession(ownerLogin.token);

    const created = await createMember(ownerSession!.membership.businessId, ownerSession!.user.id, {
      email: 'teammate@example.com',
      displayName: 'Teammate',
      role: 'AGENT',
    });
    const teammateLogin = await login('teammate@example.com', created.temporaryPassword, device);

    await expect(revokeSession(ownerSession!.user.id, teammateLogin.session.id)).rejects.toThrow();
    expect(await validateSession(teammateLogin.token)).not.toBeNull();
  });

  it('revoke-others revokes every session except the current one', async () => {
    // Plus the session beforeEach's register() call already created - three
    // "other" sessions in total once first/second/third are added. Each
    // uses a distinct device fingerprint - same-device re-logins are now
    // auto-deduped, so a real four-concurrent-session fixture needs four
    // genuinely different devices, not four logins from the same one.
    const first = await login('owner@example.com', 'correcthorsebatterystaple', { ipAddress: '10.0.0.1', userAgent: 'device-a' });
    const second = await login('owner@example.com', 'correcthorsebatterystaple', { ipAddress: '10.0.0.2', userAgent: 'device-b' });
    const third = await login('owner@example.com', 'correcthorsebatterystaple', { ipAddress: '10.0.0.3', userAgent: 'device-c' });
    const validated = await validateSession(first.token);

    const revokedCount = await revokeOtherSessions(validated!.user.id, first.session.id);
    expect(revokedCount).toBe(3);
    expect(await validateSession(first.token)).not.toBeNull();
    expect(await validateSession(second.token)).toBeNull();
    expect(await validateSession(third.token)).toBeNull();
  });

  it('renames a real session, replacing the auto-generated "<browser> on <os>" label', async () => {
    const first = await login('owner@example.com', 'correcthorsebatterystaple', { ipAddress: '10.0.0.1', userAgent: 'device-a' });
    const validated = await validateSession(first.token);

    await renameSession(validated!.user.id, first.session.id, 'My Laptop');

    const sessions = await listSessions(validated!.user.id, first.session.id);
    expect(sessions.find((s) => s.id === first.session.id)?.deviceName).toBe('My Laptop');
  });

  it('rejects an empty or overlong device name without touching the stored value', async () => {
    const first = await login('owner@example.com', 'correcthorsebatterystaple', { ipAddress: '10.0.0.1', userAgent: 'device-a' });
    const validated = await validateSession(first.token);
    const before = (await listSessions(validated!.user.id, first.session.id)).find((s) => s.id === first.session.id)?.deviceName;

    await expect(renameSession(validated!.user.id, first.session.id, '   ')).rejects.toThrow(/cannot be empty/);
    await expect(renameSession(validated!.user.id, first.session.id, 'x'.repeat(61))).rejects.toThrow(/60 characters/);

    const after = (await listSessions(validated!.user.id, first.session.id)).find((s) => s.id === first.session.id)?.deviceName;
    expect(after).toBe(before); // untouched by either rejected attempt
  });

  it('cannot rename a different user\'s session - real per-user ownership check', async () => {
    const ownerLogin = await login('owner@example.com', 'correcthorsebatterystaple', device);
    const ownerSession = await validateSession(ownerLogin.token);

    const created = await createMember(ownerSession!.membership.businessId, ownerSession!.user.id, {
      email: 'teammate2@example.com',
      displayName: 'Teammate Two',
      role: 'AGENT',
    });
    const teammateLogin = await login('teammate2@example.com', created.temporaryPassword, device);

    await expect(renameSession(ownerSession!.user.id, teammateLogin.session.id, 'Hijacked Name')).rejects.toThrow();

    const teammateSessions = await listSessions(teammateLogin.user.id, teammateLogin.session.id);
    expect(teammateSessions.find((s) => s.id === teammateLogin.session.id)?.deviceName).not.toBe('Hijacked Name');
  });
});

describe('authService same-device session dedup (real re-login from the same browser)', () => {
  beforeEach(async () => {
    await resetDatabase();
    await register({ email: 'owner@example.com', password: 'correcthorsebatterystaple', displayName: 'Owner' }, device);
  });

  it('revokes the previous session for an exact (ipAddress, userAgent) match on a new login', async () => {
    const first = await login('owner@example.com', 'correcthorsebatterystaple', device);
    expect(await validateSession(first.token)).not.toBeNull();

    const second = await login('owner@example.com', 'correcthorsebatterystaple', device);

    expect(await validateSession(first.token)).toBeNull(); // real re-login from the same device revoked the stale one
    expect(await validateSession(second.token)).not.toBeNull();
  });

  it('never revokes a session from a different IP or user agent - distinct devices/locations coexist', async () => {
    const laptop = await login('owner@example.com', 'correcthorsebatterystaple', { ipAddress: '10.0.0.1', userAgent: 'laptop-ua' });
    const phone = await login('owner@example.com', 'correcthorsebatterystaple', { ipAddress: '10.0.0.2', userAgent: 'phone-ua' });
    // Same IP as laptop, different user agent - a teammate on the same office network, not the same device.
    const teammateLaptop = await login('owner@example.com', 'correcthorsebatterystaple', { ipAddress: '10.0.0.1', userAgent: 'other-laptop-ua' });

    expect(await validateSession(laptop.token)).not.toBeNull();
    expect(await validateSession(phone.token)).not.toBeNull();
    expect(await validateSession(teammateLaptop.token)).not.toBeNull();
  });

  it('never dedupes when ipAddress or userAgent is unknown (null) - no guessing from partial information', async () => {
    const first = await login('owner@example.com', 'correcthorsebatterystaple', { ipAddress: null, userAgent: null });
    const second = await login('owner@example.com', 'correcthorsebatterystaple', { ipAddress: null, userAgent: null });

    expect(await validateSession(first.token)).not.toBeNull();
    expect(await validateSession(second.token)).not.toBeNull();
  });
});
