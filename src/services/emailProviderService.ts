/**
 * The one place that talks to an email provider.
 *
 * Resend is the implemented provider; the surface is deliberately narrow
 * (send + capabilities) so swapping to Postmark or SES is this file only.
 * Nothing here ever reports success it did not get from the provider: with
 * no API key configured, sending is honestly 'not_configured' and the email
 * stays unsent rather than being marked delivered.
 */
export type EmailProviderName = 'resend';

export interface SendEmailInput {
  fromEmail: string;
  fromName: string | null;
  replyToEmail: string | null;
  toEmail: string;
  toName: string | null;
  subject: string;
  bodyText: string;
}

export type SendEmailResult =
  | { status: 'sent'; provider: EmailProviderName; providerMessageId: string | null }
  | { status: 'not_configured'; reason: string }
  | { status: 'failed'; reason: string };

export interface EmailProviderCapabilities {
  configured: boolean;
  provider: EmailProviderName;
  reason?: string;
}

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

function getApiKey(): string | undefined {
  const key = process.env.RESEND_API_KEY;
  return key && key.trim().length > 0 ? key.trim() : undefined;
}

export function getCapabilities(): EmailProviderCapabilities {
  const configured = getApiKey() !== undefined;
  return {
    configured,
    provider: 'resend',
    ...(configured ? {} : { reason: 'RESEND_API_KEY is not set' }),
  };
}

/** RFC-shaped enough to catch real typos without rejecting valid addresses. */
export function isPlausibleEmail(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 320) return false;
  return /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(trimmed);
}

function formatAddress(email: string, name: string | null): string {
  if (!name || name.trim().length === 0) return email;
  // Quote the display name so a comma or angle bracket in it cannot forge
  // an extra recipient.
  return `"${name.replace(/["\\]/g, '')}" <${email}>`;
}

export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  const apiKey = getApiKey();
  if (!apiKey) return { status: 'not_configured', reason: 'RESEND_API_KEY is not set' };

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    let response: Response;
    try {
      response = await fetch(RESEND_ENDPOINT, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          from: formatAddress(input.fromEmail, input.fromName),
          to: [formatAddress(input.toEmail, input.toName)],
          subject: input.subject,
          text: input.bodyText,
          ...(input.replyToEmail ? { reply_to: input.replyToEmail } : {}),
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      // Surface the provider's own words - a rejected sender domain is the
      // single most common real failure and the operator needs to see it.
      const detail = await response.text().catch(() => '');
      return { status: 'failed', reason: `Resend returned HTTP ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ''}` };
    }

    const body = (await response.json().catch(() => ({}))) as { id?: unknown };
    return {
      status: 'sent',
      provider: 'resend',
      providerMessageId: typeof body.id === 'string' ? body.id : null,
    };
  } catch (error) {
    return { status: 'failed', reason: `Resend request failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}
