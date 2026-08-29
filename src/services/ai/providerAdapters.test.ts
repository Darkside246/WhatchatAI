import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@google/genai';
import { GooseProvider, GeminiProvider } from './providerAdapters.js';
import { AiGateway, ProviderConfigRejectedError } from './aiGateway.js';
import { IntegrationSettingsRepository } from '../../repositories/integrationSettingsRepository.js';
import { pool } from '../../db/pool.js';

const settingsRepository = new IntegrationSettingsRepository(pool);
const originalGooseServiceUrl = process.env.GOOSE_SERVICE_URL;

const generateContentMock = vi.fn();

// GeminiProvider's tool-calling path calls getGeminiClient() itself, so its
// tests need a fake client rather than real network access - mirroring the
// same mock shape test/aiReplyServiceRetry.test.ts already uses for the
// production WhatsApp reply path this provider must stay behaviourally
// consistent with.
vi.mock('../geminiClient.js', () => ({
  getGeminiClient: () => ({ models: { generateContent: (...args: unknown[]) => generateContentMock(...args) } }),
}));

// test/helpers.ts lives outside src/ (tsconfig rootDir), so this file - a
// src/**/*.test.ts, unlike the ones under test/ - creates its own minimal
// fixture rather than importing it. Each test gets a genuinely fresh
// business row (never truncated/reused) so business_goose_settings rows
// from different tests never collide.
async function createTestBusiness(): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(`INSERT INTO businesses (name) VALUES ('Goose Test Business') RETURNING id`);
  return rows[0]!.id;
}

function baseRequest(tenantId: string, overrides: Partial<Parameters<GooseProvider['generate']>[0]> = {}) {
  return {
    tenantId,
    operation: 'property.maintenance.triage',
    messages: [
      { role: 'system' as const, content: 'You are a helpful assistant.' },
      { role: 'user' as const, content: 'The AC is not cooling.' },
    ],
    ...overrides,
  };
}

describe('GooseProvider', () => {
  let businessId: string;

  beforeEach(async () => {
    businessId = await createTestBusiness();
    delete process.env.GOOSE_SERVICE_URL;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalGooseServiceUrl === undefined) delete process.env.GOOSE_SERVICE_URL;
    else process.env.GOOSE_SERVICE_URL = originalGooseServiceUrl;
  });

  it('capabilities() reports unavailable when nothing is configured, never fabricating availability', async () => {
    const provider = new GooseProvider();
    const caps = await provider.capabilities();
    expect(caps).toEqual({ text: false, vision: false, audio: false, video: false, documents: false, functionCalling: false });
  });

  it('capabilities() reports available when the global fallback URL is set', async () => {
    process.env.GOOSE_SERVICE_URL = 'http://127.0.0.1:3284';
    const provider = new GooseProvider();
    const caps = await provider.capabilities();
    expect(caps.text).toBe(true);
  });

  it('generate() throws a clear error when Goose is not configured at all (no workspace row, no global fallback)', async () => {
    const provider = new GooseProvider();
    await expect(provider.generate(baseRequest(businessId))).rejects.toThrow('not configured');
  });

  it('generate() throws when the workspace has explicitly disabled failover, even if globally configured', async () => {
    process.env.GOOSE_SERVICE_URL = 'http://127.0.0.1:3284';
    await settingsRepository.upsertGoose({ businessId, isEnabled: false, serviceUrl: null });
    const provider = new GooseProvider();
    await expect(provider.generate(baseRequest(businessId))).rejects.toThrow('turned off for this workspace');
  });

  it('generate() succeeds via a real per-workspace configured endpoint', async () => {
    await settingsRepository.upsertGoose({
      businessId,
      isEnabled: true,
      serviceUrl: 'http://127.0.0.1:3284',
      apiKey: 'workspace-secret',
    });
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ text: 'The AC issue has been logged.' }), { status: 200 }));

    const provider = new GooseProvider();
    const result = await provider.generate(baseRequest(businessId));

    expect(result).toEqual({ provider: 'goose', text: 'The AC issue has been logged.' });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:3284/generate',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ authorization: 'Bearer workspace-secret' }),
      }),
    );
    const [, requestInit] = fetchMock.mock.calls[0]!;
    const body = JSON.parse((requestInit as RequestInit).body as string) as { systemInstruction: string; contents: unknown[] };
    expect(body.systemInstruction).toBe('You are a helpful assistant.');
    expect(body.contents).toEqual([{ role: 'user', parts: [{ text: 'The AC is not cooling.' }] }]);
  });

  it('generate() falls back to the global env URL when no workspace row exists', async () => {
    process.env.GOOSE_SERVICE_URL = 'http://127.0.0.1:3284';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ text: 'ok' }), { status: 200 }));
    const provider = new GooseProvider();
    const result = await provider.generate(baseRequest(businessId));
    expect(result.text).toBe('ok');
  });

  it('generate() surfaces a real HTTP failure as a thrown error, never a fabricated success', async () => {
    process.env.GOOSE_SERVICE_URL = 'http://127.0.0.1:3284';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 503 }));
    const provider = new GooseProvider();
    await expect(provider.generate(baseRequest(businessId))).rejects.toThrow('HTTP 503');
  });

  it('generate() rejects media input - Goose has no multimodal understanding', async () => {
    process.env.GOOSE_SERVICE_URL = 'http://127.0.0.1:3284';
    const provider = new GooseProvider();
    await expect(
      provider.generate(baseRequest(businessId, { media: [{ mimeType: 'image/png', base64Data: 'AAAA' }] })),
    ).rejects.toThrow('text-only');
  });

  it('participates correctly in AiGateway failover: Gemini fails, Goose succeeds', async () => {
    // capabilities() can only see the global fallback (no tenantId in that
    // signature) - this represents the realistic case of a platform-wide
    // Goose reference deployment with this one workspace overriding it with
    // their own service, not the (documented, narrower) workspace-only-config
    // case the earlier "falls back to the global env URL" test covers.
    process.env.GOOSE_SERVICE_URL = 'http://127.0.0.1:9999';
    await settingsRepository.upsertGoose({ businessId, isEnabled: true, serviceUrl: 'http://127.0.0.1:3284', apiKey: null });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ text: 'Goose saved the day.' }), { status: 200 }));

    const gateway = new AiGateway();
    const failingGemini: InstanceType<typeof GeminiProvider> = {
      name: 'gemini',
      model: 'gemini-test',
      priority: 10,
      async capabilities() {
        return { text: true, vision: false, audio: false, video: false, documents: false };
      },
      async generate() {
        throw new Error('GEMINI_API_KEY is not configured');
      },
    } as unknown as InstanceType<typeof GeminiProvider>;
    gateway.register(failingGemini);
    gateway.register(new GooseProvider(40));

    const response = await gateway.generate(baseRequest(businessId));
    expect(response.provider).toBe('goose');
    expect(response.text).toBe('Goose saved the day.');
    expect(response.attemptedProviders).toEqual(['gemini', 'goose']);
  });
});

describe('GeminiProvider tool calling', () => {
  const timeTool = { name: 'get_current_time', description: 'Returns the current time', parameters: { type: 'OBJECT', properties: {} } };

  beforeEach(() => {
    generateContentMock.mockReset();
  });

  it('capabilities() reports functionCalling matching text availability', async () => {
    const provider = new GeminiProvider();
    const caps = await provider.capabilities();
    expect(caps.functionCalling).toBe(caps.text);
  });

  it('sends functionDeclarations built from the requested tools and surfaces a returned tool call', async () => {
    generateContentMock.mockResolvedValueOnce({
      text: '',
      functionCalls: [{ name: 'get_current_time', args: {} }],
    });
    const provider = new GeminiProvider();

    const result = await provider.generate({
      tenantId: 'tenant-1',
      operation: 'reply.generate',
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'Are you open right now?' },
      ],
      tools: [timeTool],
    });

    expect(result.toolCalls).toEqual([{ name: 'get_current_time', args: {} }]);
    expect(result.text).toBe('');
    const call = generateContentMock.mock.calls[0]![0] as { contents: unknown; config: { systemInstruction: string; tools: unknown } };
    expect(call.config.systemInstruction).toBe('You are a helpful assistant.');
    expect(call.config.tools).toEqual([{ functionDeclarations: [timeTool] }]);
    expect(call.contents).toEqual([{ role: 'user', parts: [{ text: 'Are you open right now?' }] }]);
  });

  it('builds the functionCall/functionResponse follow-up turns for a pendingToolCalls answer', async () => {
    generateContentMock.mockResolvedValueOnce({ text: 'We are open until 5pm.' });
    const provider = new GeminiProvider();

    const result = await provider.generate({
      tenantId: 'tenant-1',
      operation: 'reply.generate',
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'Are you open right now?' },
      ],
      tools: [timeTool],
      pendingToolCalls: [{ name: 'get_current_time', args: {} }],
      toolResponses: [{ name: 'get_current_time', response: { iso: '2026-08-28T15:00:00Z' } }],
    });

    expect(result.text).toBe('We are open until 5pm.');
    expect(result.toolCalls).toBeUndefined();
    const call = generateContentMock.mock.calls[0]![0] as { contents: Array<{ role: string; parts: unknown[] }> };
    expect(call.contents).toEqual([
      { role: 'user', parts: [{ text: 'Are you open right now?' }] },
      { role: 'model', parts: [{ functionCall: { name: 'get_current_time', args: {} } }] },
      { role: 'user', parts: [{ functionResponse: { name: 'get_current_time', response: { iso: '2026-08-28T15:00:00Z' } } }] },
    ]);
  });

  it('rejects a mismatched pendingToolCalls/toolResponses count rather than guessing', async () => {
    const provider = new GeminiProvider();
    await expect(
      provider.generate({
        tenantId: 'tenant-1',
        operation: 'reply.generate',
        messages: [{ role: 'user', content: 'Are you open right now?' }],
        tools: [timeTool],
        pendingToolCalls: [{ name: 'get_current_time', args: {} }],
        toolResponses: [],
      }),
    ).rejects.toThrow('matching pendingToolCalls and toolResponses');
    expect(generateContentMock).not.toHaveBeenCalled();
  });

  it('rejects media on the tool-calling path - not yet supported', async () => {
    const provider = new GeminiProvider();
    await expect(
      provider.generate({
        tenantId: 'tenant-1',
        operation: 'reply.generate',
        messages: [{ role: 'user', content: 'What time is it?' }],
        tools: [timeTool],
        media: [{ mimeType: 'image/png', base64Data: 'AAAA' }],
      }),
    ).rejects.toThrow('does not currently support media');
    expect(generateContentMock).not.toHaveBeenCalled();
  });
});

describe('GeminiProvider config-rejection retry', () => {
  const timeTool = { name: 'get_current_time', description: 'Returns the current time', parameters: { type: 'OBJECT', properties: {} } };

  beforeEach(() => {
    generateContentMock.mockReset();
  });

  it('translates a bare 400 into ProviderConfigRejectedError on the non-tool path', async () => {
    generateContentMock.mockRejectedValueOnce(new ApiError({ message: 'Bad Request', status: 400 }));
    const provider = new GeminiProvider();
    await expect(
      provider.generate({ tenantId: 'tenant-1', operation: 'reply.suggest', messages: [{ role: 'user', content: 'Draft a reply.' }], temperature: 0.7 }),
    ).rejects.toThrow(ProviderConfigRejectedError);
  });

  it('translates a bare 400 into ProviderConfigRejectedError on the tool-calling path', async () => {
    generateContentMock.mockRejectedValueOnce(new ApiError({ message: 'Bad Request', status: 400 }));
    const provider = new GeminiProvider();
    await expect(
      provider.generate({ tenantId: 'tenant-1', operation: 'reply.generate', messages: [{ role: 'user', content: 'Are you open?' }], tools: [timeTool], temperature: 0.6 }),
    ).rejects.toThrow(ProviderConfigRejectedError);
  });

  it('does not convert an unrelated failure (503, generic error) into a config rejection', async () => {
    generateContentMock.mockRejectedValueOnce(new ApiError({ message: 'The service is currently unavailable.', status: 503 }));
    const provider = new GeminiProvider();
    let caught: unknown;
    try {
      await provider.generate({ tenantId: 'tenant-1', operation: 'reply.suggest', messages: [{ role: 'user', content: 'Draft a reply.' }] });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect(caught).not.toBeInstanceOf(ProviderConfigRejectedError);
  });

  it('generateReduced() sends only system instruction, conversation turns, and maxOutputTokens - no tools, no temperature', async () => {
    generateContentMock.mockResolvedValueOnce({ text: 'We are open until 5pm.' });
    const provider = new GeminiProvider();

    const result = await provider.generateReduced({
      tenantId: 'tenant-1',
      operation: 'reply.generate',
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'Are you open right now?' },
      ],
      maxOutputTokens: 512,
    });

    expect(result).toEqual({ provider: 'gemini', text: 'We are open until 5pm.' });
    const call = generateContentMock.mock.calls[0]![0] as { contents: unknown; config: Record<string, unknown> };
    expect(call.config).toEqual({ systemInstruction: 'You are a helpful assistant.', maxOutputTokens: 512 });
    expect(call.contents).toEqual([{ role: 'user', parts: [{ text: 'Are you open right now?' }] }]);
    expect(call.config).not.toHaveProperty('temperature');
    expect(call.config).not.toHaveProperty('tools');
    expect(call.config).not.toHaveProperty('thinkingConfig');
  });

  it('generateReduced() throws on an empty response rather than fabricating a reply', async () => {
    generateContentMock.mockResolvedValueOnce({ text: '' });
    const provider = new GeminiProvider();
    await expect(
      provider.generateReduced({ tenantId: 'tenant-1', operation: 'reply.generate', messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toThrow('empty response');
  });

  it('AiGateway end-to-end: a config-rejected Gemini call recovers via generateReduced without falling over to another provider', async () => {
    generateContentMock
      .mockRejectedValueOnce(new ApiError({ message: 'Bad Request', status: 400 }))
      .mockResolvedValueOnce({ text: 'Recovered with the bare minimum request.' });

    const gateway = new AiGateway();
    gateway.register(new GeminiProvider());

    const response = await gateway.generate({
      tenantId: 'tenant-1',
      operation: 'reply.generate',
      messages: [{ role: 'user', content: 'Are you open right now?' }],
      temperature: 0.6,
    });

    expect(response.provider).toBe('gemini');
    expect(response.text).toBe('Recovered with the bare minimum request.');
    expect(response.attemptedProviders).toEqual(['gemini']);
    expect(generateContentMock).toHaveBeenCalledTimes(2);
  });
});
