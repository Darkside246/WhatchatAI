import { describe, expect, it, vi } from 'vitest';
import { InternetTimeProvider } from '../../src/services/time/internetTimeProvider.js';

function fakeResponse(body: string, ok = true, status = 200): Response {
  return { ok, status, text: () => Promise.resolve(body) } as unknown as Response;
}

describe('InternetTimeProvider (real calibration source, with every failure mode handled explicitly)', () => {
  it('parses a genuine Cloudflare-trace-shaped response into a UTC millis value', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fakeResponse('fl=1f1\nh=example.com\nts=1755777600.123\nvisit_scheme=https\n'));
    const provider = new InternetTimeProvider({ fetchImpl });

    const result = await provider.getCurrentUtcTime();

    expect(result.source).toBe('internet');
    expect(result.utcMillis).toBe(1755777600123);
  });

  it('rejects on an HTTP error status rather than fabricating a time', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fakeResponse('', false, 503));
    const provider = new InternetTimeProvider({ fetchImpl });
    await expect(provider.getCurrentUtcTime()).rejects.toThrow(/HTTP 503/);
  });

  it('rejects on a rate-limited (429) response the same as any other HTTP failure', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fakeResponse('', false, 429));
    const provider = new InternetTimeProvider({ fetchImpl });
    await expect(provider.getCurrentUtcTime()).rejects.toThrow(/HTTP 429/);
  });

  it('rejects on a malformed response body with no parseable ts= field', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fakeResponse('not a real trace response'));
    const provider = new InternetTimeProvider({ fetchImpl });
    await expect(provider.getCurrentUtcTime()).rejects.toThrow(/parseable/);
  });

  it('rejects on a non-finite/garbage timestamp value rather than propagating garbage', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fakeResponse('ts=not-a-number\n'));
    const provider = new InternetTimeProvider({ fetchImpl });
    await expect(provider.getCurrentUtcTime()).rejects.toThrow();
  });

  it('rejects when the request exceeds the configured timeout, instead of hanging', async () => {
    const fetchImpl = vi.fn().mockImplementation((_url: string, init?: { signal?: AbortSignal }) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('The operation was aborted')));
      });
    });
    const provider = new InternetTimeProvider({ fetchImpl, timeoutMs: 20 });

    await expect(provider.getCurrentUtcTime()).rejects.toThrow(/timed out/);
  });

  it('propagates a genuine network failure (not a timeout) honestly', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('getaddrinfo ENOTFOUND'));
    const provider = new InternetTimeProvider({ fetchImpl });
    await expect(provider.getCurrentUtcTime()).rejects.toThrow(/ENOTFOUND/);
  });
});
