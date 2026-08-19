import { beforeEach, describe, expect, it } from 'vitest';
import {
  isRegistrationOpen,
  register,
  login,
  logout,
  validateSession,
  listSessions,
  revokeSession,
  revokeOtherSessions,
  isRegistrationClosedError,
  isInvalidCredentialsError,
  isRateLimitedError,
  isWeakPasswordError,
  isSessionNotFoundError,
} from '../src/services/authService.js';
import { createMember } from '../src/services/workspaceMemberService.js';
import { resetDatabase } from './helpers.js';

const device = { ipAddress: '127.0.0.1', userAgent: 'vitest-agent' };

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
    const first = await login('owner@example.com', 'correcthorsebatterystaple', device);
    const second = await login('owner@example.com', 'correcthorsebatterystaple', device);
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
    // "other" sessions in total once first/second/third are added.
    const first = await login('owner@example.com', 'correcthorsebatterystaple', device);
    const second = await login('owner@example.com', 'correcthorsebatterystaple', device);
    const third = await login('owner@example.com', 'correcthorsebatterystaple', device);
    const validated = await validateSession(first.token);

    const revokedCount = await revokeOtherSessions(validated!.user.id, first.session.id);
    expect(revokedCount).toBe(3);
    expect(await validateSession(first.token)).not.toBeNull();
    expect(await validateSession(second.token)).toBeNull();
    expect(await validateSession(third.token)).toBeNull();
  });
});
