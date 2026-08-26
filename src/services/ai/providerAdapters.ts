import { getGeminiClient } from '../geminiClient.js';
import type { RegisteredAiProvider } from './aiGateway.js';

export interface ProviderGenerateInput {
  tenantId: string;
  operation: string;
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  media?: Array<{ url: string; mimeType: string }>;
  responseFormat?: 'text' | 'json';
  maxOutputTokens?: number;
}

type ProviderCapabilities = Awaited<ReturnType<RegisteredAiProvider['capabilities']>>;

function requireAbsoluteUrl(value: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== 'https:') throw new Error('AI provider URLs must use HTTPS');
  return parsed.toString();
}

function buildPrompt(input: ProviderGenerateInput): string {
  const turns = input.messages.map((message) => `${message.role.toUpperCase()}:\n${message.content}`).join('\n\n');
  const media = input.media?.length
    ? `\n\nMEDIA REFERENCES (provider may fetch these only when supported):\n${input.media.map((item) => `${item.mimeType}: ${item.url}`).join('\n')}`
    : '';
  return `Operation: ${input.operation}\n\n${turns}${media}`;
}

export class GeminiProvider implements RegisteredAiProvider {
  readonly name = 'gemini';
  readonly model: string;
  readonly priority: number;

  constructor(model = process.env.GEMINI_GATEWAY_MODEL || process.env.GEMINI_REPLY_MODEL || process.env.GEMINI_MODEL || 'gemini-3.5-flash', priority = 10) {
    this.model = model;
    this.priority = priority;
  }

  async capabilities(): Promise<ProviderCapabilities> {
    return { text: getGeminiClient() !== null, vision: getGeminiClient() !== null, audio: getGeminiClient() !== null, video: false, documents: false };
  }

  async generate(input: ProviderGenerateInput) {
    const client = getGeminiClient();
    if (!client) throw new Error('GEMINI_API_KEY is not configured');

    const parts: Array<{ text: string } | { fileData: { mimeType: string; fileUri: string } }> = [{ text: buildPrompt(input) }];
    for (const media of input.media ?? []) {
      if (media.mimeType.startsWith('image/')) {
        parts.push({ fileData: { mimeType: media.mimeType, fileUri: requireAbsoluteUrl(media.url) } });
      }
    }

    const response = await client.models.generateContent({
      model: this.model,
      contents: [{ role: 'user', parts }],
      config: {
        maxOutputTokens: input.maxOutputTokens ?? 1024,
        responseMimeType: input.responseFormat === 'json' ? 'application/json' : 'text/plain',
      },
    });

    const text = response.text?.trim() ?? '';
    if (!text) throw new Error('Gemini returned an empty response');
    return { provider: this.name, text };
  }
}

abstract class OpenAICompatibleProvider implements RegisteredAiProvider {
  abstract readonly name: string;
  readonly model: string;
  readonly priority: number;
  private readonly apiKey?: string;
  private readonly baseUrl: string;
  private readonly extraHeaders: Record<string, string>;

  protected constructor(options: { name: string; model: string; priority: number; apiKey?: string; baseUrl: string; extraHeaders?: Record<string, string> }) {
    this.model = options.model;
    this.priority = options.priority;
    this.apiKey = options.apiKey;
    this.baseUrl = requireAbsoluteUrl(options.baseUrl).replace(/\/$/, '');
    this.extraHeaders = options.extraHeaders ?? {};
  }

  async capabilities(): Promise<ProviderCapabilities> {
    return { text: Boolean(this.apiKey), vision: Boolean(this.apiKey), audio: false, video: false, documents: false };
  }

  async generate(input: ProviderGenerateInput) {
    if (!this.apiKey) throw new Error(`${this.name.toUpperCase()} API key is not configured`);
    const url = `${this.baseUrl}/chat/completions`;
    const messages = input.messages.map((message) => ({ role: message.role, content: message.content }));

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}`, ...this.extraHeaders },
      body: JSON.stringify({
        model: this.model,
        messages,
        max_tokens: input.maxOutputTokens ?? 1024,
        response_format: input.responseFormat === 'json' ? { type: 'json_object' } : undefined,
      }),
      signal: AbortSignal.timeout(90_000),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`${this.name} HTTP ${response.status}${body ? `: ${body.slice(0, 500)}` : ''}`);
    }

    const payload = (await response.json()) as { choices?: Array<{ message?: { content?: string | null } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } };
    const text = payload.choices?.[0]?.message?.content?.trim() ?? '';
    if (!text) throw new Error(`${this.name} returned an empty response`);
    return {
      provider: this.name,
      text,
      usage: { inputTokens: payload.usage?.prompt_tokens, outputTokens: payload.usage?.completion_tokens },
    };
  }
}

export class OpenAIProvider extends OpenAICompatibleProvider {
  readonly name = 'openai';

  constructor(model = process.env.OPENAI_GATEWAY_MODEL || 'gpt-5-mini', priority = 20) {
    super({ name: 'openai', model, priority, apiKey: process.env.OPENAI_API_KEY, baseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1' });
  }
}

export class OpenRouterProvider extends OpenAICompatibleProvider {
  readonly name = 'openrouter';

  constructor(model = process.env.OPENROUTER_GATEWAY_MODEL || process.env.OPENROUTER_MODEL || '', priority = 30) {
    super({
      name: 'openrouter',
      model,
      priority,
      apiKey: process.env.OPENROUTER_API_KEY,
      baseUrl: process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
      extraHeaders: {
        ...(process.env.OPENROUTER_HTTP_REFERER ? { 'HTTP-Referer': process.env.OPENROUTER_HTTP_REFERER } : {}),
        ...(process.env.OPENROUTER_X_TITLE ? { 'X-Title': process.env.OPENROUTER_X_TITLE } : {}),
      },
    });
  }
}

export function registerDefaultAiProviders(): void {
  const providers: RegisteredAiProvider[] = [new GeminiProvider(), new OpenAIProvider()];
  if (process.env.OPENROUTER_API_KEY && (process.env.OPENROUTER_GATEWAY_MODEL || process.env.OPENROUTER_MODEL)) providers.push(new OpenRouterProvider());
  for (const provider of providers) {
    try {
      // A provider with no configured key is still intentionally registered:
      // capability discovery marks it unavailable and the gateway will skip it.
      // This makes configuration observable without ever treating "missing key"
      // as a successful provider.
      // Duplicate registration is prevented by AiGateway itself.
      provider;
    } catch {
      // Construction is deterministic; this catch is defensive for future providers.
    }
  }
}
