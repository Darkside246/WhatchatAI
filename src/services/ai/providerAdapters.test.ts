import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@google/genai';
import { GooseProvider, GeminiProvider, OpenAIProvider } from './providerAdapters.js';
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

  it('translates a bare 400 into ProviderConfigRejectedError on the tool-calling path once the internal thinkingConfig-dropped retry also 400s', async () => {
    // Two calls now, not one: generateWithTools retries once internally
    // with thinkingConfig dropped (tools/temperature preserved - see the
    // test below) before ever reaching asConfigRejection. Both must fail
    // here to prove the ultimate ProviderConfigRejectedError fallback still
    // works once that internal retry is also exhausted.
    generateContentMock.mockRejectedValueOnce(new ApiError({ message: 'Bad Request', status: 400 }));
    generateContentMock.mockRejectedValueOnce(new ApiError({ message: 'Bad Request', status: 400 }));
    const provider = new GeminiProvider();
    await expect(
      provider.generate({ tenantId: 'tenant-1', operation: 'reply.generate', messages: [{ role: 'user', content: 'Are you open?' }], tools: [timeTool], temperature: 0.6 }),
    ).rejects.toThrow(ProviderConfigRejectedError);
    expect(generateContentMock).toHaveBeenCalledTimes(2);
  });

  it('retries once with thinkingConfig dropped (tools and temperature preserved) on a 400, and succeeds without ever reaching ProviderConfigRejectedError', async () => {
    // The real fix: assistantModeService.ts's action tools (create_reminder)
    // can never safely drop `tools` on a fallback retry (AiGateway itself
    // refuses to - see aiGateway.ts), but dropping only thinkingConfig
    // carries no such risk, and this codebase has already isolated it as
    // (part of) the trigger for this exact class of vague Gemini 400 twice
    // before (aiReplyService.ts's own retry).
    generateContentMock.mockRejectedValueOnce(new ApiError({ message: 'Bad Request', status: 400 }));
    generateContentMock.mockResolvedValueOnce({ text: 'Sure, I can do that.', functionCalls: [] });
    const provider = new GeminiProvider();

    const result = await provider.generate({
      tenantId: 'tenant-1',
      operation: 'assistant.chat',
      messages: [{ role: 'user', content: 'Remind me in an hour to call John.' }],
      tools: [timeTool],
      temperature: 0.6,
    });

    expect(result.text).toBe('Sure, I can do that.');
    expect(generateContentMock).toHaveBeenCalledTimes(2);
    const secondCallConfig = generateContentMock.mock.calls[1]?.[0]?.config;
    expect(secondCallConfig).not.toHaveProperty('thinkingConfig');
    expect(secondCallConfig.tools).toEqual([{ functionDeclarations: [timeTool] }]); // tool contract preserved
    expect(secondCallConfig.temperature).toBe(0.6);
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

/**
 * Regression coverage for a real incident: a reasoning-style OpenAI-
 * compatible model (confirmed live against NVIDIA's nemotron-3.5-lightning)
 * spends real output tokens on an internal <thinking> pass before it ever
 * writes the visible reply - if the response gets cut off by max_tokens
 * before that finishes, the raw in-progress reasoning (including literal
 * system-prompt/persona text) lands in the same `content` field a real
 * answer would use. That reasoning text was relayed straight to real
 * WhatsApp customers before this guard existed. Unlike GooseProvider (whose
 * CLI already separates a `thinking`-typed part from a real `text` part
 * itself), this raw chat-completions response has no such split - the only
 * reliable signal is `finish_reason: 'length'`.
 */
describe('OpenAICompatibleProvider rejects a truncated response instead of relaying raw reasoning', () => {
  const originalOpenAiApiKey = process.env.OPENAI_API_KEY;

  beforeEach(() => {
    process.env.OPENAI_API_KEY = 'test-key';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalOpenAiApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalOpenAiApiKey;
  });

  it('throws rather than returning content when finish_reason is "length", even though content is non-empty', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              finish_reason: 'length',
              message: { content: "Here's a thinking process:\n\n1. **Analyze User Input:** ... CRITICAL IDENTITY CONSTRAINT: Never refer to yourself in the third person." },
            },
          ],
        }),
        { status: 200 },
      ),
    );

    const provider = new OpenAIProvider();
    await expect(
      provider.generate({ tenantId: 'tenant-1', operation: 'reply.fallback', messages: [{ role: 'user', content: 'unspoken words' }] }),
    ).rejects.toThrow('truncated');
  });

  it('returns the real reply when the response finished normally', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'Sometimes the things left unsaid speak the loudest.' } }] }),
        { status: 200 },
      ),
    );

    const provider = new OpenAIProvider();
    const result = await provider.generate({ tenantId: 'tenant-1', operation: 'reply.fallback', messages: [{ role: 'user', content: 'unspoken words' }] });

    expect(result.text).toBe('Sometimes the things left unsaid speak the loudest.');
  });

  it('requests a generous token budget by default, so a real reasoning pass has room to finish before hitting the ceiling', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'ok' } }] }), { status: 200 }));

    const provider = new OpenAIProvider();
    await provider.generate({ tenantId: 'tenant-1', operation: 'reply.fallback', messages: [{ role: 'user', content: 'hi' }] });

    const [, requestInit] = fetchMock.mock.calls[0]!;
    const body = JSON.parse(requestInit!.body as string) as { max_tokens: number };
    expect(body.max_tokens).toBeGreaterThanOrEqual(4096);
  });

  /**
   * Regression coverage for a second, real incident, distinct from the
   * finish_reason:length case above: the generation completed NORMALLY
   * (finish_reason: 'stop') but the model's own chosen, intentional answer
   * WAS its internal reasoning narrative - happened when a customer asked
   * meta-questions like "what about your thinking process". No amount of
   * token budget fixes this, since it isn't truncation - it needs its own
   * check on the literal output.
   */
  it('throws when finish_reason is "stop" but the content is a raw reasoning narrative, not a real answer', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              finish_reason: 'stop',
              message: {
                content:
                  "The user is saying that Haji told them I did not send the message, and they want me to send a message to Haji now via kai. I need to be careful here.",
              },
            },
          ],
        }),
        { status: 200 },
      ),
    );

    const provider = new OpenAIProvider();
    await expect(
      provider.generate({ tenantId: 'tenant-1', operation: 'reply.fallback', messages: [{ role: 'user', content: 'he told me you did not send him' }] }),
    ).rejects.toThrow('reasoning trace');
  });
});

/**
 * Regression coverage for a real, confirmed incident: this dev
 * environment's own network relay is intermittently flaky (a request to
 * NVIDIA failed to connect at all, then succeeded cleanly a few seconds
 * later - google.com failed identically at the exact same moment,
 * confirming it's not the provider). A blip lasting a couple of seconds
 * shouldn't cost a whole reply attempt.
 */
describe('OpenAICompatibleProvider retries once on a genuine network-level failure', () => {
  const originalOpenAiApiKey = process.env.OPENAI_API_KEY;

  beforeEach(() => {
    process.env.OPENAI_API_KEY = 'test-key';
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    if (originalOpenAiApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalOpenAiApiKey;
  });

  it('recovers on the second attempt after the first fetch() call throws (connection failure, not an HTTP error)', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'Recovered fine.' } }] }), { status: 200 }));

    const provider = new OpenAIProvider();
    const resultPromise = provider.generate({ tenantId: 'tenant-1', operation: 'reply.fallback', messages: [{ role: 'user', content: 'hi' }] });
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result.text).toBe('Recovered fine.');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('surfaces the original error when both attempts fail to connect', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));

    const provider = new OpenAIProvider();
    const resultPromise = provider.generate({ tenantId: 'tenant-1', operation: 'reply.fallback', messages: [{ role: 'user', content: 'hi' }] });
    const assertion = expect(resultPromise).rejects.toThrow('fetch failed');
    await vi.runAllTimersAsync();
    await assertion;
  });

  it('never retries a real HTTP error response - only a genuine connection failure', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 401 }));

    const provider = new OpenAIProvider();
    await expect(
      provider.generate({ tenantId: 'tenant-1', operation: 'reply.fallback', messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toThrow('HTTP 401');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
