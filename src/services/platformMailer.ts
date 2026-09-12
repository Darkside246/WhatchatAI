import { sendEmail, type EmailTransport, type SendEmailResult } from './emailProviderService.js';

/**
 * AURA's OWN sender, for mail the platform sends on its own behalf.
 *
 * Distinct from the per-workspace email settings, which exist so a business
 * can send invoices and receipts as itself. A password reset is not from
 * the business - it is from AURA, to someone who cannot currently sign in,
 * and it must work for an account whose own email is unconfigured, expired,
 * or the very thing they have lost access to.
 *
 * Configured entirely from the environment, because it is one credential
 * for the whole installation rather than a per-tenant setting. Everything
 * is optional: with nothing set, isConfigured() is false and the caller
 * falls back to another channel rather than pretending to have sent
 * something.
 *
 * SMTP through Resend (smtp.resend.com:587, username "resend", password =
 * the API key) is the shape this was built for, but the settings are
 * ordinary SMTP, so any host works - Postmark, SES, a mail server - without
 * a code change.
 */

export interface PlatformMailerSettings {
  transport: EmailTransport;
  fromEmail: string;
  fromName: string;
}

function env(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * The platform sender, or null when it has not been set up.
 *
 * Read on every call rather than cached at import time so a container that
 * gains the credential on restart starts working without anything else
 * knowing, and so a test can set it per case.
 */
export function platformMailerSettings(): PlatformMailerSettings | null {
  const fromEmail = env('PLATFORM_EMAIL_FROM');
  if (!fromEmail) return null;
  const fromName = env('PLATFORM_EMAIL_FROM_NAME') ?? 'AURA';

  const host = env('PLATFORM_SMTP_HOST');
  if (host) {
    const port = Number(env('PLATFORM_SMTP_PORT') ?? '587');
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
    return {
      fromEmail,
      fromName,
      transport: {
        kind: 'smtp',
        host,
        port,
        // 465 is implicit TLS; 587 is STARTTLS, which nodemailer negotiates
        // with secure:false. Derived from the port rather than asked for as
        // a separate setting, because getting those two out of step is the
        // most common way an SMTP config silently fails to connect.
        secure: port === 465,
        username: env('PLATFORM_SMTP_USERNAME') ?? null,
        password: env('PLATFORM_SMTP_PASSWORD') ?? null,
      },
    };
  }

  // Resend's HTTP API, for an installation that would rather not use SMTP
  // at all. Same credential either way.
  const apiKey = env('PLATFORM_RESEND_API_KEY');
  if (apiKey) return { fromEmail, fromName, transport: { kind: 'resend', apiKey } };

  return null;
}

export function isPlatformMailerConfigured(): boolean {
  return platformMailerSettings() !== null;
}

/**
 * Sends one platform email, or reports honestly that it could not.
 *
 * Never throws: the callers are flows where a failed send has a real
 * alternative (another channel, a message to the person on screen), and an
 * exception would turn a recoverable situation into a 500.
 */
export async function sendPlatformEmail(input: {
  toEmail: string;
  toName: string | null;
  subject: string;
  bodyText: string;
}): Promise<SendEmailResult> {
  const settings = platformMailerSettings();
  if (!settings) {
    return { status: 'failed', reason: 'No platform email sender is configured (PLATFORM_EMAIL_FROM is unset).' };
  }

  try {
    return await sendEmail(settings.transport, {
      fromEmail: settings.fromEmail,
      fromName: settings.fromName,
      replyToEmail: null,
      toEmail: input.toEmail,
      toName: input.toName,
      subject: input.subject,
      bodyText: input.bodyText,
    });
  } catch (error) {
    return { status: 'failed', reason: error instanceof Error ? error.message : String(error) };
  }
}
