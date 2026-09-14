import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Whether a serious finding actually leaves the building.
 *
 * A security review found the oversight sweep detecting auth abuse
 * correctly, writing a finding row and an audit event, and then telling
 * nobody - while a fully built email-and-Telegram path sat beside it, used
 * only by database and queue health. A credential-stuffing run raised a
 * real, severity-high finding that waited in a table for somebody to go
 * looking.
 *
 * This drives the whole chain rather than the wire in isolation: real
 * audit rows in Postgres, the real sweep, the real finding, and the actual
 * outbound channel functions at the far end. Anything that quietly unhooks
 * the dispatch fails here.
 */

const sendEmailAlert = vi.fn().mockResolvedValue({ sent: true });
const sendTelegramAlert = vi.fn().mockResolvedValue({ sent: true });

vi.mock('../src/services/alerting/alertChannels.js', () => ({
  sendEmailAlert: (...args: unknown[]) => sendEmailAlert(...args),
  sendTelegramAlert: (...args: unknown[]) => sendTelegramAlert(...args),
}));

const { pool } = await import('../src/db/pool.js');
const { runOversightSweep } = await import('../src/services/oversight/oversightSweepService.js');
const { SecurityAuditLogRepository } = await import('../src/repositories/securityAuditLogRepository.js');
const { resetDatabase } = await import('./helpers.js');

const securityAuditLogRepository = new SecurityAuditLogRepository(pool);

// Same environment quirk the sibling sweep test documents: a real
// GOOSE_SERVICE_URL with nothing listening makes every sweep eat a real 5s
// timeout inside checkApplicationHealth.
let originalGooseUrl: string | undefined;
beforeEach(() => {
  originalGooseUrl = process.env.GOOSE_SERVICE_URL;
  delete process.env.GOOSE_SERVICE_URL;
  sendEmailAlert.mockClear();
  sendTelegramAlert.mockClear();
});
afterEach(() => {
  if (originalGooseUrl !== undefined) process.env.GOOSE_SERVICE_URL = originalGooseUrl;
});

async function recordMany(eventType: 'auth_rate_limited' | 'sentinel_ai_unavailable', count: number) {
  for (let i = 0; i < count; i++) {
    await securityAuditLogRepository.record({ businessId: null, eventType, rawMetadata: {} });
  }
}

describe('a serious finding reaches a person', () => {
  it('sends on both channels when auth abuse crosses into high', async () => {
    // 90 trips is three times the default threshold, which is where the rule
    // calls it high rather than medium.
    await resetDatabase();
    await recordMany('auth_rate_limited', 90);
    await runOversightSweep();

    expect(sendEmailAlert).toHaveBeenCalled();
    expect(sendTelegramAlert).toHaveBeenCalled();
  });

  it('carries the finding title and what to do about it', async () => {
    await resetDatabase();
    await recordMany('auth_rate_limited', 90);
    await runOversightSweep();

    const message = sendTelegramAlert.mock.calls[0]![0] as string;
    expect(message).toContain('AURA SECURITY');
    expect(message).toContain('rate-limit trips');
    // The recommended investigation, not just a metric - somebody woken by
    // this needs to know where to look.
    expect(message).toContain('security-events');
  });

  it('sends for screening that has started failing open, which nothing used to watch', async () => {
    await resetDatabase();
    await recordMany('sentinel_ai_unavailable', 60);
    await runOversightSweep();

    expect(sendTelegramAlert).toHaveBeenCalled();
    expect(sendTelegramAlert.mock.calls[0]![0] as string).toContain('failing open');
  });

  it('does not send again while the same condition keeps triggering', async () => {
    // The dedup that makes this liveable: a still-true finding bumps its
    // occurrence count silently. An alert every fifteen minutes for the
    // same outage is an alert channel people mute.
    await resetDatabase();
    await recordMany('auth_rate_limited', 90);
    await runOversightSweep();
    const afterFirst = sendTelegramAlert.mock.calls.length;

    await runOversightSweep();
    await runOversightSweep();
    expect(sendTelegramAlert.mock.calls.length).toBe(afterFirst);
  });

  it('stays quiet on a medium finding', async () => {
    // 30 trips is the threshold itself - real, worth looking at during the
    // day, and not worth waking somebody for. It is still a finding row and
    // still in the audit log.
    await resetDatabase();
    await recordMany('auth_rate_limited', 30);
    await runOversightSweep();
    expect(sendTelegramAlert).not.toHaveBeenCalled();
  });

  it('stays completely quiet on a clean platform', async () => {
    await resetDatabase();
    await runOversightSweep();
    expect(sendEmailAlert).not.toHaveBeenCalled();
    expect(sendTelegramAlert).not.toHaveBeenCalled();
  });

  it('still records the finding when every channel is dead', async () => {
    // A failing mail provider must cost a notification, never the record.
    await resetDatabase();
    sendEmailAlert.mockRejectedValueOnce(new Error('smtp exploded'));
    sendTelegramAlert.mockRejectedValueOnce(new Error('network down'));
    await recordMany('auth_rate_limited', 90);
    await runOversightSweep();

    const { rows } = await pool.query(
      "SELECT 1 FROM oversight_findings WHERE finding_type = 'auth_abuse_spike'",
    );
    expect(rows).toHaveLength(1);
  });
});
