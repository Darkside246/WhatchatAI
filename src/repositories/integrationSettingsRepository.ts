import type { Queryable } from './types.js';
import { getEncryptionService } from '../security/encryption/index.js';

export type EmailProviderKind = 'resend' | 'smtp';

/**
 * Settings as the rest of the app uses them - secrets already decrypted.
 * This shape must never be returned to a browser; see the *Public variants
 * below, which report only whether a secret is set.
 */
export interface EmailSettingsResolved {
  businessId: string;
  provider: EmailProviderKind;
  fromEmail: string;
  fromName: string | null;
  replyToEmail: string | null;
  resendApiKey: string | null;
  smtpHost: string | null;
  smtpPort: number | null;
  smtpSecure: boolean;
  smtpUsername: string | null;
  smtpPassword: string | null;
  lastTestAt: string | null;
  lastTestOk: boolean | null;
  lastTestError: string | null;
}

/** Safe to send to the browser: every secret is reduced to a boolean. */
export interface EmailSettingsPublic {
  provider: EmailProviderKind;
  fromEmail: string;
  fromName: string | null;
  replyToEmail: string | null;
  resendApiKeySet: boolean;
  smtpHost: string | null;
  smtpPort: number | null;
  smtpSecure: boolean;
  smtpUsername: string | null;
  smtpPasswordSet: boolean;
  lastTestAt: string | null;
  lastTestOk: boolean | null;
  lastTestError: string | null;
}

interface EmailRow {
  business_id: string;
  provider: EmailProviderKind;
  from_email: string;
  from_name: string | null;
  reply_to_email: string | null;
  resend_api_key_encrypted: string | null;
  smtp_host: string | null;
  smtp_port: number | null;
  smtp_secure: boolean;
  smtp_username: string | null;
  smtp_password_encrypted: string | null;
  last_test_at: string | null;
  last_test_ok: boolean | null;
  last_test_error: string | null;
}

/**
 * Secrets are stored as serialized AES-256-GCM envelopes, keyed per tenant -
 * the same mechanism message bodies use. tryParse returns null for anything
 * that is not an envelope, which keeps a hand-edited plaintext value
 * readable rather than crashing the mail path.
 */
async function encryptSecret(businessId: string, plaintext: string | null | undefined): Promise<string | null> {
  if (plaintext === null || plaintext === undefined || plaintext.length === 0) return null;
  const service = getEncryptionService();
  return service.serialize(await service.encryptField(businessId, plaintext));
}

async function decryptSecret(businessId: string, stored: string | null): Promise<string | null> {
  if (!stored) return null;
  const service = getEncryptionService();
  const envelope = service.tryParse(stored);
  if (!envelope) return stored;
  return service.decryptField(businessId, envelope);
}

export class IntegrationSettingsRepository {
  constructor(private readonly db: Queryable) {}

  async getEmailResolved(businessId: string): Promise<EmailSettingsResolved | null> {
    const { rows } = await this.db.query<EmailRow>('SELECT * FROM business_email_settings WHERE business_id = $1', [businessId]);
    const row = rows[0];
    if (!row) return null;
    return {
      businessId: row.business_id,
      provider: row.provider,
      fromEmail: row.from_email,
      fromName: row.from_name,
      replyToEmail: row.reply_to_email,
      resendApiKey: await decryptSecret(businessId, row.resend_api_key_encrypted),
      smtpHost: row.smtp_host,
      smtpPort: row.smtp_port,
      smtpSecure: row.smtp_secure,
      smtpUsername: row.smtp_username,
      smtpPassword: await decryptSecret(businessId, row.smtp_password_encrypted),
      lastTestAt: row.last_test_at,
      lastTestOk: row.last_test_ok,
      lastTestError: row.last_test_error,
    };
  }

  async getEmailPublic(businessId: string): Promise<EmailSettingsPublic | null> {
    const { rows } = await this.db.query<EmailRow>('SELECT * FROM business_email_settings WHERE business_id = $1', [businessId]);
    const row = rows[0];
    if (!row) return null;
    return {
      provider: row.provider,
      fromEmail: row.from_email,
      fromName: row.from_name,
      replyToEmail: row.reply_to_email,
      // Never the value itself, only that one exists.
      resendApiKeySet: row.resend_api_key_encrypted !== null,
      smtpHost: row.smtp_host,
      smtpPort: row.smtp_port,
      smtpSecure: row.smtp_secure,
      smtpUsername: row.smtp_username,
      smtpPasswordSet: row.smtp_password_encrypted !== null,
      lastTestAt: row.last_test_at,
      lastTestOk: row.last_test_ok,
      lastTestError: row.last_test_error,
    };
  }

  /**
   * Upserts email settings. A secret of `undefined` means "leave whatever is
   * stored alone" - so the UI can save the form without ever round-tripping
   * the existing key through the browser. An empty string means "clear it".
   */
  async upsertEmail(input: {
    businessId: string;
    provider: EmailProviderKind;
    fromEmail: string;
    fromName: string | null;
    replyToEmail: string | null;
    resendApiKey?: string | null | undefined;
    smtpHost?: string | null | undefined;
    smtpPort?: number | null | undefined;
    smtpSecure?: boolean | undefined;
    smtpUsername?: string | null | undefined;
    smtpPassword?: string | null | undefined;
  }): Promise<void> {
    const resendEncrypted = input.resendApiKey === undefined ? undefined : await encryptSecret(input.businessId, input.resendApiKey);
    const smtpPasswordEncrypted =
      input.smtpPassword === undefined ? undefined : await encryptSecret(input.businessId, input.smtpPassword);

    await this.db.query(
      `INSERT INTO business_email_settings
         (business_id, provider, from_email, from_name, reply_to_email,
          resend_api_key_encrypted, smtp_host, smtp_port, smtp_secure, smtp_username, smtp_password_encrypted)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9, true), $10, $11)
       ON CONFLICT (business_id) DO UPDATE SET
         provider = EXCLUDED.provider,
         from_email = EXCLUDED.from_email,
         from_name = EXCLUDED.from_name,
         reply_to_email = EXCLUDED.reply_to_email,
         resend_api_key_encrypted = CASE WHEN $12 THEN EXCLUDED.resend_api_key_encrypted ELSE business_email_settings.resend_api_key_encrypted END,
         smtp_host = EXCLUDED.smtp_host,
         smtp_port = EXCLUDED.smtp_port,
         smtp_secure = COALESCE($9, business_email_settings.smtp_secure),
         smtp_username = EXCLUDED.smtp_username,
         smtp_password_encrypted = CASE WHEN $13 THEN EXCLUDED.smtp_password_encrypted ELSE business_email_settings.smtp_password_encrypted END,
         updated_at = now()`,
      [
        input.businessId,
        input.provider,
        input.fromEmail,
        input.fromName,
        input.replyToEmail,
        resendEncrypted ?? null,
        input.smtpHost ?? null,
        input.smtpPort ?? null,
        input.smtpSecure ?? null,
        input.smtpUsername ?? null,
        smtpPasswordEncrypted ?? null,
        input.resendApiKey !== undefined,
        input.smtpPassword !== undefined,
      ],
    );
  }

  async recordEmailTest(businessId: string, ok: boolean, error: string | null): Promise<void> {
    await this.db.query(
      `UPDATE business_email_settings
         SET last_test_at = now(), last_test_ok = $2, last_test_error = $3, updated_at = now()
       WHERE business_id = $1`,
      [businessId, ok, error?.slice(0, 500) ?? null],
    );
  }
}
