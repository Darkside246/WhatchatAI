import type {
  AIProviderAdapter,
  AIProviderToolCall,
  AIProviderToolDefinition,
  AIProviderToolResponse,
} from '../../domain/platform/contracts.js';
import { looksLikeRawReasoningTrace } from './reasoningLeakGuard.js';

interface ProviderOptions {
  name: string;
  model: string;
  apiKey: string | undefined;
  baseUrl: string;
  priority: number;
}

type ProviderCapabilities = Awaited<ReturnType<AIProviderAdapter['capabilities']>>;

type ChatMessage =
  | { role: 'system' | 'user' | 'assistant'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> }
  | { role: 'tool'; tool_call_id: string; content: string };

/**
 * Safe OpenAI-compatible adapter for providers whose Chat Completions APIs
 * support application-managed function calling. It intentionally sends no
 * tenant/chat/contact identifiers as provider metadata. The provider only
 * receives the already-approved conversation context and tool schemas.
 *
 * This is deliberately separate from the native OpenAI Responses adapter:
 * provider compatibility is useful here, but we do not pretend that all
 * providers have identical semantics.
 */
export abstract class OpenAICompatibleToolProvider implements AIProviderAdapter {
  readonly name: string;
  readonly model: string;
  readonly priority: number;
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;

  protected constructor(options: ProviderOptions) {
    this.name = options.name;
    this.model = options.model;
    this.priority = options.priority;
    this.apiKey = options.apiKey;
    const parsed = new URL(options.baseUrl);
    if (parsed.protocol !== 'https:') throw new Error(`${options.name} base URL must use HTTPS`);
    this.baseUrl = parsed.toString().replace(/\/$/, '');
  }

  async capabilities(): Promise<ProviderCapabilities> {
    return {
      text: Boolean(this.apiKey && this.model),
      vision: false,
      audio: false,
      video: false,
      documents: false,
      functionCalling: Boolean(this.apiKey && this.model),
    };
  }

  private buildMessages(input: Parameters<AIProviderAdapter['generate']>[0]): ChatMessage[] {
    const messages: ChatMessage[] = input.messages.map((message) => ({
      role: message.role,
      content: message.content,
    }));

    if (!input.pendingToolCalls?.length) return messages;
    if (!input.toolResponses || input.pendingToolCalls.length !== input.toolResponses.length) {
      throw new Error(`${this.name} requires matching pendingToolCalls and toolResponses`);
    }

    const toolCalls = input.pendingToolCalls.map((call, index) => ({
      id: `aura_tool_${index}`,
      type: 'function' as const,
      function: { name: call.name, arguments: JSON.stringify(call.args) },
    }));
    messages.push({ role: 'assistant', content: null, tool_calls: toolCalls });

    input.toolResponses.forEach((response, index) => {
      messages.push({
        role: 'tool',
        tool_call_id: `aura_tool_${index}`,
        content: JSON.stringify(response.response),
      });
    });

    return messages;
  }

  private buildTools(tools: AIProviderToolDefinition[]) {
    return tools.map((tool) => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
  }

  async generate(input: Parameters<AIProviderAdapter['generate']>[0]) {
    if (!this.apiKey) throw new Error(`${this.name.toUpperCase()} API key is not configured`);
    if (!this.model) throw new Error(`${this.name.toUpperCase()} model is not configured`);
    if (input.media?.length) throw new Error(`${this.name} provider is text-only in the safe baseline adapter`);

    const messages = this.buildMessages(input);
    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      max_tokens: input.maxOutputTokens ?? 4096,
      parallel_tool_calls: false,
    };
    if (input.temperature !== undefined) body.temperature = input.temperature;
    if (input.responseFormat === 'json') body.response_format = { type: 'json_object' };
    if (input.tools?.length) {
      body.tools = this.buildTools(input.tools);
      body.tool_choice = 'auto';
    }

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (error) {
      throw new Error(`${this.name} network failure: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (!response.ok) {
      // Do not relay the provider response body. It can contain request data,
      // internal diagnostics, or provider-specific identifiers. The HTTP
      // status is sufficient for routing/failover decisions.
      throw new Error(`${this.name} HTTP ${response.status}`);
    }

    const payload = (await response.json()) as {
      choices?: Array<{
        finish_reason?: string | null;
        message?: {
          content?: string | null;
          tool_calls?: Array<{
            id?: string;
            type?: string;
            function?: { name?: string; arguments?: string };
          }>;
        };
      }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };

    const choice = payload.choices?.[0];
    if (!choice?.message) throw new Error(`${this.name} returned no assistant message`);
    if (choice.finish_reason === 'length') throw new Error(`${this.name} response was truncated before completion`);

    const toolCalls: AIProviderToolCall[] = [];
    for (const [index, call] of (choice.message.tool_calls ?? []).entries()) {
      const name = call.function?.name?.trim();
      const rawArguments = call.function?.arguments;
      if (!name || rawArguments === undefined) throw new Error(`${this.name} returned an invalid tool call`);
      let args: Record<string, unknown>;
      try {
        const parsed = JSON.parse(rawArguments) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('arguments must be an object');
        args = parsed as Record<string, unknown>;
      } catch {
        throw new Error(`${this.name} returned invalid JSON tool arguments for call ${index}`);
      }
      toolCalls.push({ name, args });
    }

    const text = choice.message.content?.trim() ?? '';
    if (!text && toolCalls.length === 0) throw new Error(`${this.name} returned an empty response`);
    if (text && looksLikeRawReasoningTrace(text)) throw new Error(`${this.name} response looked like a raw internal reasoning trace`);

    const result: {
      text: string;
      provider: string;
      toolCalls?: AIProviderToolCall[];
      usage?: { inputTokens?: number; outputTokens?: number };
    } = { text, provider: this.name };
    if (toolCalls.length) result.toolCalls = toolCalls;
    const usage: { inputTokens?: number; outputTokens?: number } = {};
    if (payload.usage?.prompt_tokens !== undefined) usage.inputTokens = payload.usage.prompt_tokens;
    if (payload.usage?.completion_tokens !== undefined) usage.outputTokens = payload.usage.completion_tokens;
    if (Object.keys(usage).length) result.usage = usage;
    return result;
  }
}

export class GroqProvider extends OpenAICompatibleToolProvider {
  constructor(model = process.env.GROQ_GATEWAY_MODEL || 'openai/gpt-oss-120b', priority = 25) {
    super({
      name: 'groq',
      model,
      apiKey: process.env.GROQ_API_KEY,
      baseUrl: process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1',
      priority,
    });
  }
}

export class CerebrasProvider extends OpenAICompatibleToolProvider {
  constructor(model = process.env.CEREBRAS_GATEWAY_MODEL || 'gpt-oss-120b', priority = 30) {
    super({
      name: 'cerebras',
      model,
      apiKey: process.env.CEREBRAS_API_KEY,
      baseUrl: process.env.CEREBRAS_BASE_URL || 'https://api.cerebras.ai/v1',
      priority,
    });
  }
}

export class MistralProvider extends OpenAICompatibleToolProvider {
  constructor(model = process.env.MISTRAL_GATEWAY_MODEL || 'mistral-small-latest', priority = 35) {
    super({
      name: 'mistral',
      model,
      apiKey: process.env.MISTRAL_API_KEY,
      baseUrl: process.env.MISTRAL_BASE_URL || 'https://api.mistral.ai/v1',
      priority,
    });
  }
}
