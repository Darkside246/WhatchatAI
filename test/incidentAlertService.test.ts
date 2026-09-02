import { beforeEach, describe, expect, it, vi } from 'vitest';
import { checkAndAlert, __resetAlertStateForTests, type AlertDispatchers } from '../src/services/alerting/incidentAlertService.js';

function healthyState() {
  return {
    database: { available: true, error: null, checkedAt: 'x' },
    redis: { available: true, error: null },
    queues: { healthy: true, queues: [] },
    goose: { configured: false, reachable: false, lastSuccessAt: null, lastFailureAt: null, lastFailureReason: null, consecutiveFailureCount: 0 },
    ai: { configured: true, model: 'gemini-3.5-flash-lite' },
  };
}

function fakeDispatchers(): AlertDispatchers & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    email: vi.fn(async (_subject: string, body: string) => {
      calls.push(`email:${body}`);
      return { sent: true };
    }),
    telegram: vi.fn(async (message: string) => {
      calls.push(`telegram:${message}`);
      return { sent: true };
    }),
  };
}

describe('incidentAlertService.checkAndAlert (real state-machine logic, dispatchers injected)', () => {
  beforeEach(() => {
    __resetAlertStateForTests();
  });

  it('sends no alert while everything is healthy', async () => {
    const dispatchers = fakeDispatchers();
    const result = await checkAndAlert(async () => healthyState(), dispatchers);
    expect(result).toEqual({ fired: [], reminded: [], recovered: [] });
    expect(dispatchers.calls).toHaveLength(0);
  });

  it('fires a real incident alert on the transition from healthy to unhealthy', async () => {
    const dispatchers = fakeDispatchers();
    const down = { ...healthyState(), database: { available: false, error: 'connection refused', checkedAt: 'x' } };
    const result = await checkAndAlert(async () => down, dispatchers);

    expect(result.fired).toHaveLength(1);
    expect(result.fired[0]?.key).toBe('database');
    expect(dispatchers.calls.some((c) => c.includes('INCIDENT') && c.includes('connection refused'))).toBe(true);
  });

  it('does not re-fire on every check while the same condition stays active, only after the reminder interval', async () => {
    process.env.ALERT_REMINDER_INTERVAL_MS = '1000';
    const dispatchers = fakeDispatchers();
    const down = { ...healthyState(), redis: { available: false, error: 'ECONNREFUSED' } };

    await checkAndAlert(async () => down, dispatchers, 0);
    expect(dispatchers.calls).toHaveLength(2); // email + telegram for the initial fire

    dispatchers.calls.length = 0;
    await checkAndAlert(async () => down, dispatchers, 500); // still within the reminder window
    expect(dispatchers.calls).toHaveLength(0);

    await checkAndAlert(async () => down, dispatchers, 1500); // past the reminder window
    expect(dispatchers.calls.some((c) => c.includes('STILL DOWN'))).toBe(true);

    delete process.env.ALERT_REMINDER_INTERVAL_MS;
  });

  it('sends a real recovered alert once a condition clears, and never re-fires it as a new incident', async () => {
    const dispatchers = fakeDispatchers();
    const down = { ...healthyState(), queues: { healthy: false, queues: [{ name: 'incoming_messages', waiting: 999, active: 0, completed: 0, failed: 0, delayed: 0, healthy: false }] } };

    await checkAndAlert(async () => down, dispatchers);
    dispatchers.calls.length = 0;

    const result = await checkAndAlert(async () => healthyState(), dispatchers);
    expect(result.recovered).toEqual(['queues']);
    expect(dispatchers.calls.some((c) => c.includes('RECOVERED') && c.includes('queues'))).toBe(true);
  });

  it('never alerts on Goose when it was never configured - that is expected, not an incident', async () => {
    const dispatchers = fakeDispatchers();
    const state = { ...healthyState(), goose: { configured: false, reachable: false, lastSuccessAt: null, lastFailureAt: null, lastFailureReason: null, consecutiveFailureCount: 0 } };
    const result = await checkAndAlert(async () => state, dispatchers);
    expect(result.fired).toHaveLength(0);
  });

  it('does alert when Goose is configured but genuinely unreachable', async () => {
    const dispatchers = fakeDispatchers();
    const state = { ...healthyState(), goose: { configured: true, reachable: false, reason: 'ECONNREFUSED', lastSuccessAt: null, lastFailureAt: 'x', lastFailureReason: 'ECONNREFUSED', consecutiveFailureCount: 3 } };
    const result = await checkAndAlert(async () => state, dispatchers);
    expect(result.fired).toHaveLength(1);
    expect(result.fired[0]?.key).toBe('goose');
  });

  it('logs an error but does not throw when both channels are unconfigured/fail', async () => {
    const dispatchers: AlertDispatchers = {
      email: vi.fn(async () => ({ sent: false, reason: 'not configured' })),
      telegram: vi.fn(async () => ({ sent: false, reason: 'not configured' })),
    };
    const down = { ...healthyState(), database: { available: false, error: 'down', checkedAt: 'x' } };
    await expect(checkAndAlert(async () => down, dispatchers)).resolves.toBeDefined();
  });
});
