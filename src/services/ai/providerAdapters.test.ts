import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GooseProvider, GeminiProvider } from './providerAdapters.js';
import { AiGateway } from './aiGateway.js';
import { IntegrationSettingsRepository } from '../../repositories/integrationSettingsRepository.js';
import { pool } from '../../db/pool.js';

const settingsRepository = new IntegrationSettingsRepository(pool);
const originalGooseServiceUrl = process.env.GOOSE_SERVICE_URL;

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
    expect(caps).toEqual({ text: false, vision: false, audio: false, video: false, documents: false });
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
