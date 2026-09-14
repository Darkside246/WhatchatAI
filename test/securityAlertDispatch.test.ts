import { describe, expect, it, vi } from 'vitest';
import { dispatchSecurityAlert, shouldDispatch, type AlertDispatchers } from '../src/services/alerting/securityAlertDispatch.js';

/**
 * Getting a security finding in front of a person.
 *
 * A security review found the oversight sweep detecting auth abuse
 * correctly, writing a finding and an audit row, and then telling nobody -
 * while a fully built email-and-Telegram path sat beside it, used only by
 * database and queue health. A credential-stuffing run raised a real,
 * severity-high finding that waited in a table for somebody to go looking.
 *
 * Detection that reaches nobody is a log, not a control. These pin the wire.
 */

function dispatchers(overrides: Partial<AlertDispatchers> = {}): AlertDispatchers {
  return {
    email: vi.fn().mockResolvedValue({ sent: true }),
    telegram: vi.fn().mockResolvedValue({ sent: true }),
    ...overrides,
  };
}

describe('which findings are worth waking somebody for', () => {
  it('dispatches critical and high', () => {
    expect(shouldDispatch('critical')).toBe(true);
    expect(shouldDispatch('high')).toBe(true);
  });

  it('does not dispatch the rest', () => {
    // A channel that cries wolf is one people mute, which is strictly worse
    // than having none. Everything is still recorded at every severity -
    // this decides only what gets pushed.
    for (const severity of ['medium', 'low', 'informational'] as const) {
      expect(shouldDispatch(severity)).toBe(false);
    }
  });
});

describe('sending one', () => {
  const alert = { severity: 'high' as const, title: 'Repeated login rate-limit trips', detail: 'Check the source IPs.' };

  it('goes out on every configured channel, not the first that works', async () => {
    // Whoever is on call may be watching one and not the other.
    const channels = dispatchers();
    await dispatchSecurityAlert(alert, channels);
    expect(channels.email).toHaveBeenCalledTimes(1);
    expect(channels.telegram).toHaveBeenCalledTimes(1);
  });

  it('carries what somebody should actually go and do, not just a number', async () => {
    const channels = dispatchers();
    await dispatchSecurityAlert(alert, channels);
    const message = (channels.telegram as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(message).toContain('Repeated login rate-limit trips');
    expect(message).toContain('Check the source IPs.');
    expect(message).toContain('HIGH');
  });

  it('still counts as delivered when only one channel is configured', async () => {
    // The normal state of a real deployment: Telegram set up, email not, or
    // the other way round.
    const result = await dispatchSecurityAlert(alert, dispatchers({
      email: vi.fn().mockResolvedValue({ sent: false, reason: 'not configured' }),
    }));
    expect(result.delivered).toBe(true);
  });

  it('reports honestly when nothing is configured, rather than pretending', async () => {
    const result = await dispatchSecurityAlert(alert, dispatchers({
      email: vi.fn().mockResolvedValue({ sent: false, reason: 'not configured' }),
      telegram: vi.fn().mockResolvedValue({ sent: false, reason: 'not configured' }),
    }));
    expect(result.delivered).toBe(false);
  });

  it('never throws, whatever a channel does', async () => {
    // This runs inside a sweep that has to keep going, and the finding is
    // already saved by the time it is called - a dead mail provider must
    // cost a notification, never the rest of the checks.
    const result = await dispatchSecurityAlert(alert, dispatchers({
      email: vi.fn().mockRejectedValue(new Error('smtp exploded')),
      telegram: vi.fn().mockRejectedValue(new Error('network down')),
    }));
    expect(result.delivered).toBe(false);
  });

  it('tries both channels even when the first one throws', async () => {
    const channels = dispatchers({ email: vi.fn().mockRejectedValue(new Error('smtp exploded')) });
    const result = await dispatchSecurityAlert(alert, channels);
    expect(channels.telegram).toHaveBeenCalledTimes(1);
    expect(result.delivered).toBe(true);
  });

  it('marks itself as security, so it is not mistaken for a health alert', async () => {
    const channels = dispatchers();
    await dispatchSecurityAlert(alert, channels);
    expect((channels.telegram as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string).toContain('AURA SECURITY');
  });
});
