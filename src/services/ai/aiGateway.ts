import type { AiProviderAdapter } from '../../domain/platform/contracts.js';

export interface GatewayMedia {
  url: string;
  mimeType: string;
}

export interface GatewayMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface GatewayRequest {
  tenantId: string;
  operation: string;
  messages: GatewayMessage[];
  media?: GatewayMedia[];
  responseFormat?: 'text' | 'json';
  preferredProvider?: string;
  providerAllowlist?: string[];
  maxOutputTokens?: number;
}

export interface GatewayResponse {
  provider: string;
  model: string;
  text: string;
  usage?: { inputTokens?: number; outputTokens?: number };
  attemptedProviders: string[];
}

export interface RegisteredAiProvider extends AiProviderAdapter {
  model: string;
  priority: number;
}

export class AiGateway {
  private readonly providers = new Map<string, RegisteredAiProvider>();

  register(provider: RegisteredAiProvider): void {
    if (this.providers.has(provider.name)) {
      throw new Error(`AI provider "${provider.name}" is already registered`);
    }
    this.providers.set(provider.name, provider);
  }

  unregister(providerName: string): boolean {
    return this.providers.delete(providerName);
  }

  listProviders(): Array<{ name: string; model: string; priority: number }> {
    return [...this.providers.values()]
      .sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name))
      .map((provider) => ({ name: provider.name, model: provider.model, priority: provider.priority }));
  }

  async health(): Promise<Record<string, boolean>> {
    const entries = await Promise.all(
      [...this.providers.values()].map(async (provider) => {
        try {
          const capabilities = await provider.capabilities();
          return [provider.name, capabilities.text] as const;
        } catch {
          return [provider.name, false] as const;
        }
      }),
    );
    return Object.fromEntries(entries);
  }

  async generate(request: GatewayRequest): Promise<GatewayResponse> {
    if (!request.tenantId) throw new Error('AI gateway requires tenantId');
    if (request.messages.length === 0) throw new Error('AI gateway requires at least one message');

    const eligible = [...this.providers.values()]
      .filter((provider) => !request.providerAllowlist || request.providerAllowlist.includes(provider.name))
      .sort((a, b) => {
        if (request.preferredProvider === a.name) return -1;
        if (request.preferredProvider === b.name) return 1;
        return a.priority - b.priority;
      });

    if (eligible.length === 0) throw new Error('No eligible AI providers are registered');

    const attemptedProviders: string[] = [];
    const failures: string[] = [];

    for (const provider of eligible) {
      attemptedProviders.push(provider.name);
      try {
        const capabilities = await provider.capabilities();
        if (!capabilities.text) throw new Error('provider does not advertise text generation');
        if (request.media?.length && !capabilities.vision && request.media.some((item) => item.mimeType.startsWith('image/'))) {
          throw new Error('provider does not advertise image analysis');
        }
        if (request.media?.length && !capabilities.audio && request.media.some((item) => item.mimeType.startsWith('audio/'))) {
          throw new Error('provider does not advertise audio processing');
        }

        const response = await provider.generate({
          tenantId: request.tenantId,
          operation: request.operation,
          messages: request.messages,
          media: request.media,
          responseFormat: request.responseFormat,
          maxOutputTokens: request.maxOutputTokens,
        });

        if (!response.text.trim()) throw new Error('provider returned an empty response');
        return {
          provider: response.provider,
          model: provider.model,
          text: response.text,
          usage: response.usage,
          attemptedProviders,
        };
      } catch (error) {
        failures.push(`${provider.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    throw new Error(`All eligible AI providers failed. ${failures.join(' | ')}`);
  }
}

export const aiGateway = new AiGateway();
