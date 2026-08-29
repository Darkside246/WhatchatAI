import { describe, expect, it, vi } from 'vitest';
import { AiGateway, ProviderConfigRejectedError, type RegisteredAiProvider, type GatewayToolCall } from './aiGateway.js';

type Caps = Awaited<ReturnType<RegisteredAiProvider['capabilities']>>;

function fakeProvider(options: {
  name: string;
  priority: number;
  model?: string;
  caps?: Caps;
  result?: string;
  error?: string;
  configRejected?: string;
  toolCalls?: GatewayToolCall[];
  onGenerate?: (input: Parameters<RegisteredAiProvider['generate']>[0]) => void;
  reduced?: { result?: string; error?: string; onGenerateReduced?: (input: Parameters<NonNullable<RegisteredAiProvider['generateReduced']>>[0]) => void };
}): RegisteredAiProvider {
  const provider: RegisteredAiProvider = {
    name: options.name,
    model: options.model ?? `${options.name}-test-model`,
    priority: options.priority,
    async capabilities() {
      return options.caps ?? { text: true, vision: false, audio: false, video: false, documents: false, functionCalling: false };
    },
    async generate(input) {
      options.onGenerate?.(input);
      if (options.configRejected) throw new ProviderConfigRejectedError(options.configRejected);
      if (options.error) throw new Error(options.error);
      const response: { provider: string; text: string; toolCalls?: GatewayToolCall[] } = {
        provider: options.name,
        text: options.result ?? 'ok',
      };
      if (options.toolCalls) response.toolCalls = options.toolCalls;
      return response;
    },
  };
  if (options.reduced) {
    provider.generateReduced = async (input) => {
      options.reduced!.onGenerateReduced?.(input);
      if (options.reduced!.error) throw new Error(options.reduced!.error);
      return { provider: options.name, text: options.reduced!.result ?? 'reduced-ok' };
    };
  }
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
    gateway.register(fakeProvider({ name: 'vision', priority: 20, caps: { text: true, vision: true, audio: false, video: false, documents: false, functionCalling: false }, result: 'seen' }));

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

  const timeToolDefinition = { name: 'get_current_time', description: 'Returns the current time', parameters: { type: 'OBJECT', properties: {} } };

  it('does not send tool-bearing requests to a provider without functionCalling capability', async () => {
    const gateway = new AiGateway();
    gateway.register(fakeProvider({ name: 'no-tools', priority: 10, caps: { text: true, vision: false, audio: false, video: false, documents: false, functionCalling: false }, result: 'wrong provider' }));
    gateway.register(fakeProvider({ name: 'tool-capable', priority: 20, caps: { text: true, vision: false, audio: false, video: false, documents: false, functionCalling: true }, result: 'seen' }));

    const result = await gateway.generate({ ...baseRequest, tools: [timeToolDefinition] });
    expect(result.provider).toBe('tool-capable');
    expect(result.attemptedProviders).toEqual(['no-tools', 'tool-capable']);
  });

  it('threads tools, pendingToolCalls and toolResponses through to the provider', async () => {
    const gateway = new AiGateway();
    const onGenerate = vi.fn();
    const pendingToolCalls: GatewayToolCall[] = [{ name: 'get_current_time', args: {} }];
    const toolResponses = [{ name: 'get_current_time', response: { iso: '2026-08-28T00:00:00Z' } }];
    gateway.register(fakeProvider({ name: 'tool-capable', priority: 10, caps: { text: true, vision: false, audio: false, video: false, documents: false, functionCalling: true }, result: 'It is 2026-08-28.', onGenerate }));

    await gateway.generate({ ...baseRequest, tools: [timeToolDefinition], pendingToolCalls, toolResponses });

    expect(onGenerate).toHaveBeenCalledWith(
      expect.objectContaining({ tools: [timeToolDefinition], pendingToolCalls, toolResponses }),
    );
  });

  it('accepts an empty-text response carrying toolCalls instead of rejecting it as empty', async () => {
    const gateway = new AiGateway();
    const toolCalls: GatewayToolCall[] = [{ name: 'get_current_time', args: {} }];
    gateway.register(fakeProvider({ name: 'tool-capable', priority: 10, caps: { text: true, vision: false, audio: false, video: false, documents: false, functionCalling: true }, result: '', toolCalls }));

    const result = await gateway.generate({ ...baseRequest, tools: [timeToolDefinition] });
    expect(result.text).toBe('');
    expect(result.toolCalls).toEqual(toolCalls);
  });

  it('retries the same provider with a reduced request after a ProviderConfigRejectedError, never touching the next provider', async () => {
    const gateway = new AiGateway();
    const onGenerate = vi.fn();
    const onGenerateReduced = vi.fn();
    gateway.register(fakeProvider({
      name: 'flaky',
      priority: 10,
      onGenerate,
      configRejected: 'rejected the temperature+thinkingConfig combination',
      reduced: { result: 'bare minimum reply', onGenerateReduced },
    }));
    gateway.register(fakeProvider({ name: 'never-reached', priority: 20, result: 'should not be used' }));

    const result = await gateway.generate({ ...baseRequest, temperature: 0.6 });

    expect(result.provider).toBe('flaky');
    expect(result.text).toBe('bare minimum reply');
    expect(result.attemptedProviders).toEqual(['flaky']);
    expect(onGenerateReduced).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: baseRequest.tenantId, operation: baseRequest.operation, messages: baseRequest.messages }),
    );
    // The reduced retry must never carry the rejected optional parameters -
    // it IS the "strip everything but the essentials" request by definition.
    const reducedInput = onGenerateReduced.mock.calls[0]![0] as Record<string, unknown>;
    expect(reducedInput).not.toHaveProperty('temperature');
    expect(reducedInput).not.toHaveProperty('tools');
  });

  it('never attempts the reduced retry when the original request required tools - must not silently drop tool support', async () => {
    const gateway = new AiGateway();
    const onGenerateReduced = vi.fn();
    gateway.register(fakeProvider({
      name: 'flaky-tool-provider',
      priority: 10,
      caps: { text: true, vision: false, audio: false, video: false, documents: false, functionCalling: true },
      configRejected: 'rejected the tools+temperature combination',
      reduced: { result: 'bare minimum reply (should never be returned here)', onGenerateReduced },
    }));

    await expect(gateway.generate({ ...baseRequest, tools: [timeToolDefinition], temperature: 0.6 })).rejects.toThrow(
      'All eligible AI providers failed',
    );
    expect(onGenerateReduced).not.toHaveBeenCalled();
  });

  it('falls through to the next provider when the config-rejected provider has no reduced fallback', async () => {
    const gateway = new AiGateway();
    gateway.register(fakeProvider({ name: 'flaky', priority: 10, configRejected: 'rejected' }));
    gateway.register(fakeProvider({ name: 'fallback', priority: 20, result: 'fallback answer' }));

    const result = await gateway.generate(baseRequest);
    expect(result.provider).toBe('fallback');
    expect(result.attemptedProviders).toEqual(['flaky', 'fallback']);
  });

  it('falls through to the next provider when the reduced retry itself fails', async () => {
    const gateway = new AiGateway();
    gateway.register(fakeProvider({ name: 'flaky', priority: 10, configRejected: 'rejected', reduced: { error: 'still broken' } }));
    gateway.register(fakeProvider({ name: 'fallback', priority: 20, result: 'fallback answer' }));

    const result = await gateway.generate(baseRequest);
    expect(result.provider).toBe('fallback');
    expect(result.attemptedProviders).toEqual(['flaky', 'fallback']);
  });

  it('does not apply the reduced-retry path to an ordinary (non-config-rejection) failure', async () => {
    const gateway = new AiGateway();
    const onGenerateReduced = vi.fn();
    gateway.register(fakeProvider({ name: 'down', priority: 10, error: 'network timeout', reduced: { onGenerateReduced } }));
    gateway.register(fakeProvider({ name: 'fallback', priority: 20, result: 'fallback answer' }));

    const result = await gateway.generate(baseRequest);
    expect(result.provider).toBe('fallback');
    expect(onGenerateReduced).not.toHaveBeenCalled();
  });
});
