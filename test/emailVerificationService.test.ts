import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { pool } from '../src/db/pool.js';
import { register } from '../src/services/authService.js';
import {
  sendWelcomeVerificationEmail,
  verifyEmailWithToken,
  VerificationTokenInvalidError,
  VerificationRateLimitedError,
} from '../src/services/emailVerificationService.js';
import {
  renderWelcomeEmailFromStrings,
  saveWelcomeTemplate,
  resetWelcomeTemplate,
  DEFAULT_WELCOME_SUBJECT,
} from '../src/services/welcomeEmailTemplate.js';
import * as platformMailer from '../src/services/platformMailer.js';
import { UserRepository } from '../src/repositories/userRepository.js';
import { resetDatabase } from './helpers.js';

const device = { ipAddress: '127.0.0.1', userAgent: 'vitest-agent' };

/**
 * The welcome email is also the address check, which is the barrier against
 * accounts made with addresses nobody can read. So what it carries - and
 * what it deliberately does not - is the feature.
 */
describe('welcome / email verification (real Postgres)', () => {
  let userId: string;
  let sent: { subject: string; bodyText: string; toEmail: string }[];

  beforeEach(async () => {
    await resetDatabase();
    sent = [];
    vi.spyOn(platformMailer, 'isPlatformMailerConfigured').mockReturnValue(true);
    vi.spyOn(platformMailer, 'sendPlatformEmail').mockImplementation(async (input) => {
      sent.push({ subject: input.subject, bodyText: input.bodyText, toEmail: input.toEmail });
      return { status: 'sent', provider: 'smtp', providerMessageId: 'test' };
    });

    // register() sends the welcome email itself - that IS the behaviour
    // under test, so the signup is the setup.
    const registered = await register(
      { email: 'owner@example.com', password: 'correcthorsebatterystaple', displayName: "O'brien Brathwaite" },
      device,
    );
    userId = registered.user.id;

    // The send is fire-and-forget by design (a mail provider having a bad
    // minute must not undo a signup that already succeeded), so it is still
    // in flight when register() resolves. Waited for here rather than
    // awaited in the service, because making it blocking to suit a test
    // would change the behaviour the test exists to check.
    await waitForEmail();
  });

  async function waitForEmail(): Promise<void> {
    const deadline = Date.now() + 3000;
    while (sent.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  afterEach(async () => {
    vi.restoreAllMocks();
    await resetWelcomeTemplate();
  });

  function tokenFromLastEmail(): string {
    const match = /token=([^\s&]+)/.exec(sent[sent.length - 1]?.bodyText ?? '');
    if (!match) throw new Error('no verification link was sent');
    return decodeURIComponent(match[1]!);
  }

  it('sends automatically on signup, addressed to the name they gave', async () => {
    expect(sent).toHaveLength(1);
    expect(sent[0]?.toEmail).toBe('owner@example.com');
    expect(sent[0]?.subject).toBe(DEFAULT_WELCOME_SUBJECT);
    expect(sent[0]?.bodyText).toContain("O'brien Brathwaite");
  });

  /**
   * The point of the design. Their name belongs in the body - it is their
   * own inbox, and a welcome that cannot say hello is not a welcome. The
   * LINK must carry nothing: anyone who intercepts it should learn that
   * somebody signed up and nothing about who.
   */
  it('puts nothing identifying in the link itself', () => {
    const token = tokenFromLastEmail();
    expect(token).not.toContain('owner@example.com');
    expect(token.toLowerCase()).not.toContain('brathwaite');
    expect(token).not.toContain(userId);

    // And it is not merely encoded - decoding base64url yields no identity
    // either, because there is none in there to find.
    const decoded = Buffer.from(token, 'base64url').toString('latin1');
    expect(decoded).not.toContain('owner');
    expect(decoded).not.toContain(userId.slice(0, 8));
  });

  it('stores only the hash, never the token', async () => {
    const token = tokenFromLastEmail();
    const { rows } = await pool.query<{ token_hash: string }>('SELECT token_hash FROM email_verification_tokens');
    expect(rows[0]?.token_hash).not.toBe(token);
    expect(rows[0]?.token_hash).toBe(createHash('sha256').update(token).digest('hex'));
  });

  it('marks the address verified when the link is opened', async () => {
    const users = new UserRepository(pool);
    expect((await users.findById(userId))?.emailVerifiedAt).toBeNull();

    await verifyEmailWithToken(tokenFromLastEmail());

    expect((await users.findById(userId))?.emailVerifiedAt).not.toBeNull();
  });

  describe('refuses', () => {
    it('the same link twice', async () => {
      const token = tokenFromLastEmail();
      await verifyEmailWithToken(token);
      await expect(verifyEmailWithToken(token)).rejects.toThrow(VerificationTokenInvalidError);
    });

    it('an expired link', async () => {
      const token = tokenFromLastEmail();
      await pool.query("UPDATE email_verification_tokens SET expires_at = now() - interval '1 minute'");
      await expect(verifyEmailWithToken(token)).rejects.toThrow(VerificationTokenInvalidError);
    });

    it('a token that was never issued', async () => {
      await expect(verifyEmailWithToken('not-a-real-token')).rejects.toThrow(VerificationTokenInvalidError);
    });

    it('more than five sends an hour', async () => {
      // One was already sent by the signup in beforeEach.
      for (let i = 0; i < 4; i += 1) await sendWelcomeVerificationEmail(userId);
      await expect(sendWelcomeVerificationEmail(userId)).rejects.toThrow(VerificationRateLimitedError);
    });
  });

  it('does not re-send to an address that is already verified', async () => {
    await verifyEmailWithToken(tokenFromLastEmail());
    const result = await sendWelcomeVerificationEmail(userId);
    expect(result.sent).toBe(false);
  });

  it('issues no token when no sender is configured', async () => {
    await pool.query('DELETE FROM email_verification_tokens');
    vi.spyOn(platformMailer, 'isPlatformMailerConfigured').mockReturnValue(false);

    const result = await sendWelcomeVerificationEmail(userId);
    expect(result.sent).toBe(false);
    const { rows } = await pool.query('SELECT 1 FROM email_verification_tokens');
    expect(rows).toHaveLength(0);
  });

  describe('the editable template', () => {
    const context = { displayName: 'Alex', verifyUrl: 'https://example.com/v?token=T', expiresInHours: 48 };

    it('substitutes the merge fields', () => {
      const rendered = renderWelcomeEmailFromStrings(
        { subject: 'Welcome, {{name}}', bodyText: 'Hi {{name}} - {{verify_url}} lasts {{expires_hours}}h' },
        context,
      );
      expect(rendered.subject).toBe('Welcome, Alex');
      expect(rendered.bodyText).toBe('Hi Alex - https://example.com/v?token=T lasts 48h');
    });

    /**
     * The link is the entire point of this email. Wording edited to drop it
     * would produce a friendly message that strands every new signup.
     */
    it('adds the link back when an edited template leaves it out', () => {
      const rendered = renderWelcomeEmailFromStrings({ subject: 'Hello', bodyText: 'No link here at all.' }, context);
      expect(rendered.bodyText).toContain('https://example.com/v?token=T');
    });

    it('uses saved wording for the real send', async () => {
      await saveWelcomeTemplate({ subject: 'Custom subject', bodyText: 'Hey {{name}} {{verify_url}}', bodyHtml: null }, userId);
      await pool.query('DELETE FROM email_verification_tokens');

      await sendWelcomeVerificationEmail(userId);

      expect(sent[sent.length - 1]?.subject).toBe('Custom subject');
      expect(sent[sent.length - 1]?.bodyText).toContain("Hey O'brien Brathwaite");
    });
  });
});
