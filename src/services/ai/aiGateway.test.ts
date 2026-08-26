import { describe, expect, it } from 'vitest';
import { AiGateway, type RegisteredAiProvider } from './aiGateway.js';

type Caps = Awaited<ReturnType<RegisteredAiProvider['capabilities']>>;

function fakeProvider(options: {
  name: string;
  priority: number;
  model?: string;
  caps?: Caps;
  result?: string;
  error?: string;
}): RegisteredAiProvider {
  const provider: RegisteredAiProvider = {
    name: options.name,
    model: options.model ?? `${options.name}-test-model`,
    priority: options.priority,
    async capabilities() {
      return options.caps ?? { text: true, vision: false, audio: false, video: false, documents: false };
    },
    async generate() {
      if (options.error) throw new Error(options.error);
      return { provider: options.name, text: options.result ?? 'ok' };
    },
  };
  return provider;
}

const baseRequest = {
  tenantId: 'tenant-1',
  operation: 'maintenance.triage',
  messages: [{ role: 'user' as const, content: 'The AC is not working.' }],
};

describe('AiGateway', () => {
  it('registers providers in priority order', () => {
    const gateway = new AiGateway();
    gateway.register(fakeProvider({ name: 'slow', priority: 20 }));
    gateway.register(fakeProvider({ name: 'fast', priority: 10 }));
    expect(gateway.listProviders().map((p) => p.name)).toEqual(['fast', 'slow']);
  });

  it('prefers the explicitly requested provider over priority', async () => {
    const gateway = new AiGateway();
    gateway.register(fakeProvider({ name: 'fast', priority: 10, result: 'fast' }));
    gateway.register(fakeProvider({ name: 'preferred', priority: 20, result: 'preferred' }));

    const result = await gateway.generate({ ...baseRequest, preferredProvider: 'preferred' });
    expect(result.provider).toBe('preferred');
    expect(result.attemptedProviders).toEqual(['preferred']);
  });

  it('falls back after a provider failure', async () => {
    const gateway = new AiGateway();
    gateway.register(fakeProvider({ name: 'primary', priority: 10, error: 'temporary failure' }));
    gateway.register(fakeProvider({ name: 'fallback', priority: 20, result: 'recovered' }));

    const result = await gateway.generate(baseRequest);
    expect(result.provider).toBe('fallback');
    expect(result.text).toBe('recovered');
    expect(result.attemptedProviders).toEqual(['primary', 'fallback']);
  });

  it('does not send image work to a provider without vision capability', async () => {
    const gateway = new AiGateway();
    gateway.register(fakeProvider({ name: 'text-only', priority: 10, result: 'wrong provider' }));
    gateway.register(fakeProvider({ name: 'vision', priority: 20, caps: { text: true, vision: true, audio: false, video: false, documents: false }, result: 'seen' }));

    const result = await gateway.generate({
      ...baseRequest,
      media: [{ mimeType: 'image/jpeg', base64Data: 'aGVsbG8=' }],
    });
    expect(result.provider).toBe('vision');
    expect(result.text).toBe('seen');
    expect(result.attemptedProviders).toEqual(['text-only', 'vision']);
  });

  it('fails closed when there are no eligible providers', async () => {
    const gateway = new AiGateway();
    gateway.register(fakeProvider({ name: 'one', priority: 10 }));
    await expect(gateway.generate({ ...baseRequest, providerAllowlist: ['missing'] })).rejects.toThrow('No eligible AI providers');
  });
});
