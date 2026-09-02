import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn<typeof fetch>();
vi.stubGlobal('fetch', fetchMock);

const { generateResponse, getHealthSummary } = await import('../src/services/gooseService.js');

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/**
 * gooseService's success/failure counters (getHealthSummary) are real
 * in-memory module state, not mocked - this file drives them through
 * real generateResponse calls (against a mocked fetch, since there is no
 * real Goose adapter in this test environment) rather than reaching into
 * private state, the same as any other caller would.
 */
describe('gooseService health summary (real in-memory success/failure tracking)', () => {
  const originalUrl = process.env.GOOSE_SERVICE_URL;

  beforeEach(() => {
    fetchMock.mockReset();
  });

  afterEach(() => {
    if (originalUrl === undefined) delete process.env.GOOSE_SERVICE_URL;
    else process.env.GOOSE_SERVICE_URL = originalUrl;
  });

  it('reports not configured, with no fabricated reachability, when no service URL is set', async () => {
    delete process.env.GOOSE_SERVICE_URL;
    const summary = await getHealthSummary();
    expect(summary.configured).toBe(false);
    expect(summary.reachable).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('tracks a real success, then a real failure, then a real recovery - never fabricating any of the three', async () => {
    process.env.GOOSE_SERVICE_URL = 'https://goose.example.test';

    // 1. A real successful generation call.
    fetchMock.mockResolvedValueOnce(jsonResponse({ text: 'Here is a real fallback reply.' }));
    const success = await generateResponse({ systemInstruction: 'Be helpful.', contents: [{ role: 'user', parts: [{ text: 'hi' }] }] });
    expect(success.status).toBe('generated');

    fetchMock.mockResolvedValueOnce(jsonResponse({ status: 'ok' }));
    let summary = await getHealthSummary();
    expect(summary.configured).toBe(true);
    expect(summary.lastSuccessAt).not.toBeNull();
    expect(summary.consecutiveFailureCount).toBe(0);
    expect(summary.lastFailureAt).toBeNull();

    // 2. Two real consecutive failures (a non-ok /generate response).
    fetchMock.mockResolvedValueOnce(new Response('boom', { status: 500 }));
    const failure1 = await generateResponse({ systemInstruction: 'Be helpful.', contents: [{ role: 'user', parts: [{ text: 'hi' }] }] });
    expect(failure1.status).toBe('unavailable');

    fetchMock.mockRejectedValueOnce(new Error('network down'));
    const failure2 = await generateResponse({ systemInstruction: 'Be helpful.', contents: [{ role: 'user', parts: [{ text: 'hi' }] }] });
    expect(failure2.status).toBe('unavailable');

    fetchMock.mockResolvedValueOnce(jsonResponse({ status: 'ok' }));
    summary = await getHealthSummary();
    expect(summary.consecutiveFailureCount).toBe(2);
    expect(summary.lastFailureAt).not.toBeNull();
    expect(summary.lastFailureReason).toContain('network down');
    // The earlier success is still remembered - a later failure never erases it.
    expect(summary.lastSuccessAt).not.toBeNull();

    // 3. A real recovery resets the consecutive-failure count, but never
    // erases the failure history itself (lastFailureAt/lastFailureReason
    // are "most recent," not "current state").
    fetchMock.mockResolvedValueOnce(jsonResponse({ text: 'Recovered.' }));
    const recovered = await generateResponse({ systemInstruction: 'Be helpful.', contents: [{ role: 'user', parts: [{ text: 'hi' }] }] });
    expect(recovered.status).toBe('generated');

    fetchMock.mockResolvedValueOnce(jsonResponse({ status: 'ok' }));
    summary = await getHealthSummary();
    expect(summary.consecutiveFailureCount).toBe(0);
    expect(summary.lastFailureAt).not.toBeNull();
  });

  it('never includes an API key or authorization header value anywhere in the reported summary', async () => {
    process.env.GOOSE_SERVICE_URL = 'https://goose.example.test';
    process.env.GOOSE_SERVICE_API_KEY = 'super-secret-key';
    try {
      fetchMock.mockResolvedValueOnce(jsonResponse({ status: 'ok' }));
      const summary = await getHealthSummary();
      expect(JSON.stringify(summary)).not.toContain('super-secret-key');
    } finally {
      delete process.env.GOOSE_SERVICE_API_KEY;
    }
  });
});
