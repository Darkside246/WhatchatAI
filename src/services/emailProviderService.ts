import nodemailer from 'nodemailer';

/**
 * The one place that talks to a mail provider.
 *
 * Two real transports: the Resend HTTP API, and ordinary SMTP - which is
 * what most businesses already have from their existing mail host. Nothing
 * here ever reports success it did not get from the provider.
 *
 * Configuration is resolved per workspace by emailService and passed in, so
 * this module holds no environment lookups of its own beyond the fallback
 * key. That keeps "which settings were actually used" answerable.
 */
export type EmailProviderName = 'resend' | 'smtp';

export interface ResendTransport {
  kind: 'resend';
  apiKey: string;
}

export interface SmtpTransport {
  kind: 'smtp';
  host: string;
  port: number;
  /** true = implicit TLS (usually 465); false = STARTTLS (usually 587). */
  secure: boolean;
  username: string | null;
  password: string | null;
}

export type EmailTransport = ResendTransport | SmtpTransport;

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
  | { status: 'failed'; reason: string };

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const SEND_TIMEOUT_MS = 20_000;

/** Only used when a workspace has not configured its own Resend key. */
export function environmentResendApiKey(): string | undefined {
  const key = process.env.RESEND_API_KEY;
  return key && key.trim().length > 0 ? key.trim() : undefined;
}

/** RFC-shaped enough to catch real typos without rejecting valid addresses. */
export function isPlausibleEmail(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 320) return false;
  return /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(trimmed);
}

function formatAddress(email: string, name: string | null): string {
  if (!name || name.trim().length === 0) return email;
  // Quote the display name so a comma or angle bracket in it cannot forge an
  // extra recipient.
  return `"${name.replace(/["\\]/g, '')}" <${email}>`;
}

async function sendViaResend(transport: ResendTransport, input: SendEmailInput): Promise<SendEmailResult> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(RESEND_ENDPOINT, {
        method: 'POST',
        headers: { authorization: `Bearer ${transport.apiKey}`, 'content-type': 'application/json' },
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
      // most common real failure and the operator needs to see it verbatim.
      const detail = await response.text().catch(() => '');
      return { status: 'failed', reason: `Resend returned HTTP ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ''}` };
    }

    const body = (await response.json().catch(() => ({}))) as { id?: unknown };
    return { status: 'sent', provider: 'resend', providerMessageId: typeof body.id === 'string' ? body.id : null };
  } catch (error) {
    return { status: 'failed', reason: `Resend request failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

async function sendViaSmtp(transport: SmtpTransport, input: SendEmailInput): Promise<SendEmailResult> {
  try {
    const mailer = nodemailer.createTransport({
      host: transport.host,
      port: transport.port,
      secure: transport.secure,
      ...(transport.username
        ? { auth: { user: transport.username, pass: transport.password ?? '' } }
        : {}),
      connectionTimeout: SEND_TIMEOUT_MS,
      greetingTimeout: SEND_TIMEOUT_MS,
      socketTimeout: SEND_TIMEOUT_MS,
    });

    const info = await mailer.sendMail({
      from: formatAddress(input.fromEmail, input.fromName),
      to: formatAddress(input.toEmail, input.toName),
      subject: input.subject,
      text: input.bodyText,
      ...(input.replyToEmail ? { replyTo: input.replyToEmail } : {}),
    });

    // A server that accepted the message returns its own id; anything else
    // would have thrown.
    return { status: 'sent', provider: 'smtp', providerMessageId: info.messageId ?? null };
  } catch (error) {
    return { status: 'failed', reason: `SMTP send failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export async function sendEmail(transport: EmailTransport, input: SendEmailInput): Promise<SendEmailResult> {
  return transport.kind === 'resend' ? sendViaResend(transport, input) : sendViaSmtp(transport, input);
}

/**
 * Proves the SMTP settings actually work - a real connection, real greeting,
 * real authentication - without sending anything to a customer. Resend has
 * no equivalent handshake, so it is verified by a real test send instead.
 */
export async function verifySmtpTransport(transport: SmtpTransport): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const mailer = nodemailer.createTransport({
      host: transport.host,
      port: transport.port,
      secure: transport.secure,
      ...(transport.username ? { auth: { user: transport.username, pass: transport.password ?? '' } } : {}),
      connectionTimeout: SEND_TIMEOUT_MS,
      greetingTimeout: SEND_TIMEOUT_MS,
      socketTimeout: SEND_TIMEOUT_MS,
    });
    await mailer.verify();
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
