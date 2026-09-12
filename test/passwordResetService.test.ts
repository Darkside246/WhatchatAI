import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { pool } from '../src/db/pool.js';
import { register, login, validateSession, isInvalidCredentialsError, isWeakPasswordError } from '../src/services/authService.js';
import {
  requestPasswordReset,
  resetPasswordWithToken,
  ResetTokenInvalidError,
  ResetRateLimitedError,
} from '../src/services/passwordResetService.js';
import * as platformMailer from '../src/services/platformMailer.js';
import { resetDatabase } from './helpers.js';

const device = { ipAddress: '127.0.0.1', userAgent: 'vitest-agent' };
const ORIGINAL = 'correcthorsebatterystaple';

/**
 * Someone who has forgotten their password cannot sign in, so every one of
 * these paths runs with no session and no tenant context. That makes the
 * refusals and the silences as much the feature as the reset itself.
 */
describe('password reset (real Postgres, real Argon2 credentials)', () => {
  let userId: string;
  let sentBodies: string[];

  beforeEach(async () => {
    await resetDatabase();
    const registered = await register({ email: 'owner@example.com', password: ORIGINAL, displayName: 'Owner' }, device);
    userId = registered.user.id;

    // A real send would need a real credential and would put mail in
    // somebody's inbox. The transport is stubbed; everything either side of
    // it - the token, the hashing, the expiry, the single use - is real.
    sentBodies = [];
    vi.spyOn(platformMailer, 'isPlatformMailerConfigured').mockReturnValue(true);
    vi.spyOn(platformMailer, 'sendPlatformEmail').mockImplementation(async (input) => {
      sentBodies.push(input.bodyText);
      return { status: 'sent', provider: 'smtp', providerMessageId: 'test' };
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Pulls the token out of the RESET email specifically, the way a person
   * clicking that link would.
   *
   * Matched on the reset path rather than taken from the last message:
   * signing up also sends a welcome email, fire-and-forget, so the two can
   * land in either order and "the last one" is sometimes the welcome.
   */
  function tokenFromLastEmail(): string {
    const resetEmail = [...sentBodies].reverse().find((body) => body.includes('/reset-password?token='));
    const match = /reset-password\?token=([^\s&]+)/.exec(resetEmail ?? '');
    if (!match) throw new Error('no reset link was sent');
    return decodeURIComponent(match[1]!);
  }

  it('emails a link that sets a new password, and retires the old one', async () => {
    const { channel } = await requestPasswordReset('owner@example.com');
    expect(channel).toBe('email');

    await resetPasswordWithToken(tokenFromLastEmail(), 'a-much-better-password');

    const signedIn = await login('owner@example.com', 'a-much-better-password', device);
    expect(signedIn.user.id).toBe(userId);
    await expect(login('owner@example.com', ORIGINAL, device)).rejects.toSatisfy(isInvalidCredentialsError);
  });

  /**
   * The token IS the credential, so what is stored must not be usable. A
   * database dump, a leaked backup or an operator reading the table must
   * not be enough to take an account.
   */
  it('never stores the token itself', async () => {
    await requestPasswordReset('owner@example.com');
    const token = tokenFromLastEmail();

    const { rows } = await pool.query<{ token_hash: string }>('SELECT token_hash FROM password_reset_tokens');
    expect(rows[0]?.token_hash).not.toBe(token);
    expect(rows[0]?.token_hash).toBe(createHash('sha256').update(token).digest('hex'));
  });

  /**
   * Not signed in, by definition - so any live session belongs either to an
   * old device or to whoever locked them out. Unlike a signed-in password
   * change, nothing is spared.
   */
  it('signs out every existing session', async () => {
    const existing = await login('owner@example.com', ORIGINAL, { ipAddress: '10.0.0.9', userAgent: 'another-device' });
    expect(await validateSession(existing.token)).not.toBeNull();

    await requestPasswordReset('owner@example.com');
    await resetPasswordWithToken(tokenFromLastEmail(), 'a-much-better-password');

    expect(await validateSession(existing.token)).toBeNull();
  });

  describe('refuses', () => {
    it('the same link twice', async () => {
      await requestPasswordReset('owner@example.com');
      const token = tokenFromLastEmail();
      await resetPasswordWithToken(token, 'a-much-better-password');

      // A reset link that works twice is a link that works for whoever
      // reads the email second.
      await expect(resetPasswordWithToken(token, 'different-password-again')).rejects.toThrow(ResetTokenInvalidError);
    });

    it('an expired link', async () => {
      await requestPasswordReset('owner@example.com');
      const token = tokenFromLastEmail();
      await pool.query("UPDATE password_reset_tokens SET expires_at = now() - interval '1 minute'");

      await expect(resetPasswordWithToken(token, 'a-much-better-password')).rejects.toThrow(ResetTokenInvalidError);
    });

    it('a token that was never issued', async () => {
      await expect(resetPasswordWithToken('not-a-real-token', 'a-much-better-password')).rejects.toThrow(ResetTokenInvalidError);
    });

    it('a new password that does not meet the policy', async () => {
      await requestPasswordReset('owner@example.com');
      await expect(resetPasswordWithToken(tokenFromLastEmail(), 'short')).rejects.toSatisfy(isWeakPasswordError);
    });

    it('more than five requests an hour for one account', async () => {
      for (let i = 0; i < 5; i += 1) await requestPasswordReset('owner@example.com');
      // Aimed at the nuisance case - a stranger repeatedly triggering reset
      // mail into someone's inbox - not at guessing, which the token's own
      // entropy already rules out.
      await expect(requestPasswordReset('owner@example.com')).rejects.toThrow(ResetRateLimitedError);
    });
  });

  describe('says nothing about who has an account', () => {
    /**
     * Confirming that an address has an account would turn this endpoint
     * into a membership oracle - anyone could test a list of addresses and
     * learn who uses AURA.
     */
    it('answers an unknown address the same way, and sends nothing', async () => {
      const result = await requestPasswordReset('nobody@example.com');
      expect(result.channel).toBeNull();
      // No RESET email, specifically. The signup in beforeEach sends a
      // welcome email fire-and-forget, so it can arrive at any point and
      // "no email at all" would fail for the wrong reason.
      expect(sentBodies.filter((body) => body.includes('/reset-password?token='))).toHaveLength(0);
      const { rows } = await pool.query('SELECT 1 FROM password_reset_tokens');
      expect(rows).toHaveLength(0);
    });
  });

  describe('when no platform sender is configured', () => {
    it('issues no token rather than pretending to have sent one', async () => {
      vi.spyOn(platformMailer, 'isPlatformMailerConfigured').mockReturnValue(false);

      const result = await requestPasswordReset('owner@example.com');
      expect(result.channel).toBeNull();

      // A token created here would be a live credential with no way to
      // reach its owner - all risk, no use.
      const { rows } = await pool.query('SELECT 1 FROM password_reset_tokens');
      expect(rows).toHaveLength(0);
    });
  });
});
