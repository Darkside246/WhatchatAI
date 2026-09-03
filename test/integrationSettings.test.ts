import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { IntegrationSettingsRepository } from '../src/repositories/integrationSettingsRepository.js';
import { resolveTransport } from '../src/services/emailService.js';
import { createTestBusiness, resetDatabase } from './helpers.js';

/**
 * The property that matters most here: a stored credential must be
 * encrypted at rest and must never come back out through the public API
 * shape a browser can read.
 */
describe('integration settings (encrypted secrets, honest precedence)', () => {
  let businessId: string;
  let repository: IntegrationSettingsRepository;
  const originalEnvKey = process.env.RESEND_API_KEY;

  beforeEach(async () => {
    await resetDatabase();
    businessId = await createTestBusiness();
    repository = new IntegrationSettingsRepository(pool);
    delete process.env.RESEND_API_KEY;
  });

  // Restore the ambient key so other suites are unaffected by this one's
  // environment fiddling.
  afterAll(() => {
    if (originalEnvKey === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = originalEnvKey;
  });

  it('stores an SMTP password encrypted, not as plaintext in the column', async () => {
    await repository.upsertEmail({
      businessId,
      provider: 'smtp',
      fromEmail: 'hello@example.com',
      fromName: null,
      replyToEmail: null,
      smtpHost: 'smtp.example.com',
      smtpPort: 587,
      smtpSecure: false,
      smtpUsername: 'mailer',
      smtpPassword: 'super-secret-password',
    });

    const { rows } = await pool.query<{ smtp_password_encrypted: string | null }>(
      'SELECT smtp_password_encrypted FROM business_email_settings WHERE business_id = $1',
      [businessId],
    );
    const stored = rows[0]?.smtp_password_encrypted ?? '';

    expect(stored).not.toContain('super-secret-password');
    expect(stored.length).toBeGreaterThan(0);

    // ...and it round-trips correctly for the code that actually sends.
    const resolved = await repository.getEmailResolved(businessId);
    expect(resolved?.smtpPassword).toBe('super-secret-password');
  });

  it('never exposes secrets through the public shape - only whether one is set', async () => {
    await repository.upsertEmail({
      businessId,
      provider: 'resend',
      fromEmail: 'hello@example.com',
      fromName: null,
      replyToEmail: null,
      resendApiKey: 're_a_real_looking_key',
    });

    const publicView = await repository.getEmailPublic(businessId);

    expect(publicView?.resendApiKeySet).toBe(true);
    expect(JSON.stringify(publicView)).not.toContain('re_a_real_looking_key');
  });

  it('keeps the stored secret when a save omits it, so saving the form cannot wipe the key', async () => {
    await repository.upsertEmail({
      businessId,
      provider: 'resend',
      fromEmail: 'hello@example.com',
      fromName: null,
      replyToEmail: null,
      resendApiKey: 'original-key',
    });

    // A second save with no key at all - what the UI sends when the operator
    // edits only the from-name.
    await repository.upsertEmail({
      businessId,
      provider: 'resend',
      fromEmail: 'hello@example.com',
      fromName: 'Renamed',
      replyToEmail: null,
    });

    const resolved = await repository.getEmailResolved(businessId);
    expect(resolved?.resendApiKey).toBe('original-key');
    expect(resolved?.fromName).toBe('Renamed');
  });

  it('prefers workspace settings over the server environment, and says which was used', async () => {
    process.env.RESEND_API_KEY = 'environment-key';

    // With nothing saved, the environment is the honest answer.
    const fromEnvironment = await resolveTransport(null);
    expect(fromEnvironment?.source).toBe('environment');

    await repository.upsertEmail({
      businessId,
      provider: 'resend',
      fromEmail: 'hello@example.com',
      fromName: null,
      replyToEmail: null,
      resendApiKey: 'workspace-key',
    });

    const settings = await repository.getEmailResolved(businessId);
    const fromWorkspace = await resolveTransport(settings);

    expect(fromWorkspace?.source).toBe('workspace');
    expect(fromWorkspace?.transport).toMatchObject({ kind: 'resend', apiKey: 'workspace-key' });
  });

  it('refuses an SMTP config with no host rather than building a half-formed transport', async () => {
    await repository.upsertEmail({
      businessId,
      provider: 'smtp',
      fromEmail: 'hello@example.com',
      fromName: null,
      replyToEmail: null,
      smtpHost: null,
      smtpPort: null,
    });

    const settings = await repository.getEmailResolved(businessId);
    expect(await resolveTransport(settings)).toBeNull();
  });
});
