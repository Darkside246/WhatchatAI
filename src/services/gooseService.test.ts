import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateResponse, healthCheck } from './gooseService.js';

afterEach(() => vi.restoreAllMocks());

describe('goose failover HTTP contract', () => {
  it('probes GET /health without requiring an API key', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ status: 'ok' }), { status: 200 }));
    const result = await healthCheck({ serviceUrl: 'http://127.0.0.1:3284', apiKey: null });
    expect(result).toEqual({ status: 'available' });
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:3284/health', expect.objectContaining({ headers: {} }));
  });

  it('posts the complete reply request to /generate and accepts {text}', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ text: 'Hello from Goose' }), { status: 200 }));
    const result = await generateResponse({
      systemInstruction: 'Reply concisely.',
      contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
      endpoint: { serviceUrl: 'http://127.0.0.1:3284', apiKey: 'secret' },
    });
    expect(result).toEqual({ status: 'generated', text: 'Hello from Goose' });
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:3284/generate', expect.objectContaining({ method: 'POST' }));
  });
});
