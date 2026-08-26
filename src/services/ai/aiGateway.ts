import type { AiProviderAdapter } from '../../domain/platform/contracts.js';

export interface GatewayMedia {
  mimeType: string;
  url?: string;
  base64Data?: string;
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

const MAX_MESSAGES = 64;
const MAX_MESSAGE_CHARS = 20_000;
const MAX_MEDIA_ITEMS = 8;
const MAX_MEDIA_BASE64_CHARS = 12_000_000;
const MAX_OUTPUT_TOKENS = 16_384;

function mediaRequires(
  capabilities: Awaited<ReturnType<RegisteredAiProvider['capabilities']>>,
  media: GatewayMedia[],
): string | null {
  if (media.length > MAX_MEDIA_ITEMS) return `too many media items (maximum ${MAX_MEDIA_ITEMS})`;
  for (const item of media) {
    if (!item.mimeType) return 'media item is missing mimeType';
    if (!item.base64Data && !item.url) return 'media item has neither base64Data nor url';
    if (item.base64Data && item.base64Data.length > MAX_MEDIA_BASE64_CHARS) return 'media item exceeds the gateway inline-data limit';
    if (item.mimeType.startsWith('image/') && !capabilities.vision) return 'provider does not advertise image analysis';
    if (item.mimeType.startsWith('audio/') && !capabilities.audio) return 'provider does not advertise audio processing';
    if (item.mimeType.startsWith('video/') && !capabilities.video) return 'provider does not advertise video processing';
    if (!/^https:\/\//i.test(item.url ?? '') && !item.base64Data) return 'remote media URLs must use HTTPS';
  }
  return null;
}

function validateRequest(request: GatewayRequest): void {
  if (!request.tenantId.trim()) throw new Error('AI gateway requires tenantId');
  if (!request.operation.trim()) throw new Error('AI gateway requires operation');
  if (request.messages.length === 0) throw new Error('AI gateway requires at least one message');
  if (request.messages.length > MAX_MESSAGES) throw new Error(`AI gateway accepts at most ${MAX_MESSAGES} messages`);
  for (const [index, message] of request.messages.entries()) {
    if (!message.content.trim()) throw new Error(`AI gateway message ${index} is empty`);
    if (message.content.length > MAX_MESSAGE_CHARS) throw new Error(`AI gateway message ${index} exceeds ${MAX_MESSAGE_CHARS} characters`);
  }
  if (request.maxOutputTokens !== undefined && (!Number.isInteger(request.maxOutputTokens) || request.maxOutputTokens < 1 || request.maxOutputTokens > MAX_OUTPUT_TOKENS)) {
    throw new Error(`maxOutputTokens must be an integer between 1 and ${MAX_OUTPUT_TOKENS}`);
  }
}

export class AiGateway {
  private readonly providers = new Map<string, RegisteredAiProvider>();

  register(provider: RegisteredAiProvider): void {
    if (this.providers.has(provider.name)) throw new Error(`AI provider "${provider.name}" is already registered`);
    this.providers.set(provider.name, provider);
  }

  registerMany(providers: RegisteredAiProvider[]): void {
    for (const provider of providers) this.register(provider);
  }

  unregister(providerName: string): boolean {
    return this.providers.delete(providerName);
  }

  clear(): void {
    this.providers.clear();
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
    validateRequest(request);

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
        if (request.media?.length) {
          const mediaError = mediaRequires(capabilities, request.media);
          if (mediaError) throw new Error(mediaError);
        }

        const response = await provider.generate({
          tenantId: request.tenantId,
          operation: request.operation,
          messages: request.messages,
          media: request.media,
          responseFormat: request.responseFormat,
          maxOutputTokens: request.maxOutputTokens,
        });

        const text = response.text.trim();
        if (!text) throw new Error('provider returned an empty response');
        if (request.responseFormat === 'json') {
          try {
            JSON.parse(text);
          } catch {
            throw new Error('provider returned invalid JSON for a JSON-formatted request');
          }
        }

        return {
          provider: response.provider,
          model: provider.model,
          text,
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
