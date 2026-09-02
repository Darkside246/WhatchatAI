import { afterEach, describe, expect, it } from 'vitest';
import { sendEmailAlert, sendTelegramAlert } from '../src/services/alerting/alertChannels.js';

const ENV_KEYS = ['ALERT_EMAIL_TO', 'ALERT_FROM_EMAIL', 'RESEND_API_KEY', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_ALERT_CHAT_ID'] as const;

describe('alertChannels (real no-op-when-unconfigured behavior, no live network calls)', () => {
  afterEach(() => {
    for (const key of ENV_KEYS) delete process.env[key];
  });

  it('sendEmailAlert no-ops with a clear reason when not fully configured', async () => {
    delete process.env.ALERT_EMAIL_TO;
    delete process.env.ALERT_FROM_EMAIL;
    delete process.env.RESEND_API_KEY;
    const result = await sendEmailAlert('subject', 'body');
    expect(result.sent).toBe(false);
    expect(result.reason).toMatch(/not fully configured/);
  });

  it('sendEmailAlert no-ops even when only one of the three required values is missing', async () => {
    process.env.ALERT_EMAIL_TO = 'ops@example.com';
    process.env.ALERT_FROM_EMAIL = 'alerts@example.com';
    delete process.env.RESEND_API_KEY;
    const result = await sendEmailAlert('subject', 'body');
    expect(result.sent).toBe(false);
  });

  it('sendTelegramAlert no-ops with a clear reason when not configured', async () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_ALERT_CHAT_ID;
    const result = await sendTelegramAlert('message');
    expect(result.sent).toBe(false);
    expect(result.reason).toMatch(/not configured/);
  });
});
