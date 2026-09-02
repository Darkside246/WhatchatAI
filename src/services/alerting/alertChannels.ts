import { sendEmail } from '../emailProviderService.js';

export interface AlertDispatchResult {
  sent: boolean;
  reason?: string;
}

/**
 * Real outbound channels for platform-level incident alerts (queue backup,
 * database/redis down, Goose fallback unreachable) - never tenant content,
 * so this deliberately bypasses the drafts/approval flow emailService.ts
 * uses for AI-drafted customer email. Both channels no-op with a clear
 * reason when not configured, the same honesty pattern as
 * emailService.ts's EmailCapabilities/gooseService's `configured` flag -
 * never silently pretend an alert was sent.
 */
export async function sendEmailAlert(subject: string, bodyText: string): Promise<AlertDispatchResult> {
  const toEmail = process.env.ALERT_EMAIL_TO?.trim();
  const fromEmail = process.env.ALERT_FROM_EMAIL?.trim();
  const apiKey = process.env.RESEND_API_KEY?.trim();
  if (!toEmail || !fromEmail || !apiKey) {
    return { sent: false, reason: 'ALERT_EMAIL_TO/ALERT_FROM_EMAIL/RESEND_API_KEY not fully configured' };
  }

  const result = await sendEmail(
    { kind: 'resend', apiKey },
    { fromEmail, fromName: 'AURA Alerts', replyToEmail: null, toEmail, toName: null, subject, bodyText },
  );
  if (result.status === 'sent') return { sent: true };
  return { sent: false, reason: result.reason };
}

export async function sendTelegramAlert(message: string): Promise<AlertDispatchResult> {
  const botToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = process.env.TELEGRAM_ALERT_CHAT_ID?.trim();
  if (!botToken || !chatId) {
    return { sent: false, reason: 'TELEGRAM_BOT_TOKEN/TELEGRAM_ALERT_CHAT_ID not configured' };
  }

  try {
    const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: message }),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      return { sent: false, reason: `Telegram API responded ${response.status}: ${body.slice(0, 200)}` };
    }
    return { sent: true };
  } catch (error) {
    return { sent: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
