import type {
  RegisteredAiProvider,
  GatewayMedia,
  GatewayToolDefinition,
  GatewayToolCall,
  GatewayToolResponse,
} from './aiGateway.js';
import { looksLikeRawReasoningTrace } from './reasoningLeakGuard.js';

interface ResponsesInputMessage {
  role: 'system' | 'user' | 'assistant';
  content: Array<{ type: 'input_text' | 'output_text'; text: string }>;
}

interface ResponsesFunctionCall extends GatewayToolCall {
  callId?: string;
}

interface ResponsesOutputItem {
  type?: string;
  role?: string;
  name?: string;
  arguments?: string;
  call_id?: string;
  content?: Array<{ type?: string; text?: string }>;
}

interface ResponsesPayload {
  output?: ResponsesOutputItem[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
}

/**
 * OpenAI's native Responses API adapter.
 *
 * Deliberately separate from the generic OpenAI-compatible chat-completions
 * adapter: Responses exposes function-call IDs explicitly, separates model
 * reasoning items from visible output, and supports `store:false`. Those are
 * materially better properties for a customer-facing agent handling PII.
 */
export class OpenAIResponsesProvider implements RegisteredAiProvider {
  readonly name = 'openai';
  readonly model: string;
  readonly priority: number;
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;

  constructor(
    model = process.env.OPENAI_GATEWAY_MODEL || 'gpt-5.6-luna',
    priority = 20,
  ) {
    this.model = model;
    this.priority = priority;
    this.apiKey = process.env.OPENAI_API_KEY;
    const rawBaseUrl = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
    const parsed = new URL(rawBaseUrl);
    if (parsed.protocol !== 'https:') throw new Error('OPENAI_BASE_URL must use HTTPS');
    this.baseUrl = parsed.toString().replace(/\/$/, '');
  }

  async capabilities() {
    const available = Boolean(this.apiKey && this.model);
    return {
      text: available,
      vision: false,
      audio: false,
      video: false,
      documents: false,
      functionCalling: available,
    };
  }

  private static toInputMessages(messages: ProviderMessage[]): ResponsesInputMessage[] {
    return messages.map((message) => ({
      role: message.role,
      content: [{
        type: message.role === 'assistant' ? 'output_text' : 'input_text',
        text: message.content,
      }],
    }));
  }

  private static toTools(tools: GatewayToolDefinition[]) {
    return tools.map((tool) => ({
      type: 'function' as const,
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      // Do not force strict mode globally. Existing AURA tool schemas were
      // designed for Gemini and may not satisfy OpenAI strict-schema rules.
      strict: false,
    }));
  }

  private static appendPendingToolTurn(
    input: Array<Record<string, unknown>>,
    pendingToolCalls: GatewayToolCall[],
    toolResponses: GatewayToolResponse[],
  ): void {
    for (let index = 0; index < pendingToolCalls.length; index += 1) {
      const call = pendingToolCalls[index] as ResponsesFunctionCall;
      const response = toolResponses[index];
      if (!response) throw new Error('OpenAI provider received an unmatched tool response');
      if (!call.callId) {
        throw new Error('OpenAI provider requires the original function call id for a tool follow-up');
      }

      input.push({
        type: 'function_call',
        call_id: call.callId,
        name: call.name,
        arguments: JSON.stringify(call.args),
      });
      input.push({
        type: 'function_call_output',
        call_id: call.callId,
        output: JSON.stringify(response.response),
      });
    }
  }

  async generate(input: ProviderGenerateInput) {
    if (!this.apiKey) throw new Error('OPENAI API key is not configured');
    if (!this.model) throw new Error('OPENAI model is not configured');
    if (input.media?.length) {
      throw new Error('OpenAI Responses adapter currently accepts text only through the safe baseline path');
    }
    if (input.tools?.length && input.pendingToolCalls && !input.toolResponses) {
      throw new Error('OpenAI tool follow-up requires toolResponses');
    }
    if ((input.pendingToolCalls?.length ?? 0) !== (input.toolResponses?.length ?? 0)) {
      throw new Error('OpenAI provider requires matching pendingToolCalls and toolResponses');
    }

    const inputItems: Array<Record<string, unknown>> = OpenAIResponsesProvider
      .toInputMessages(input.messages)
      .map((message) => message as unknown as Record<string, unknown>);

    if (input.pendingToolCalls?.length) {
      OpenAIResponsesProvider.appendPendingToolTurn(inputItems, input.pendingToolCalls, input.toolResponses!);
    }

    const body: Record<string, unknown> = {
      model: this.model,
      input: inputItems,
      // Customer conversations can contain PII. Do not opt into persisted
      // Responses application state from this adapter. This is not a claim
      // that all platform abuse/security logs disappear, and it does not
      // substitute for an eligible Zero Data Retention agreement.
      store: false,
      parallel_tool_calls: false,
      max_output_tokens: input.maxOutputTokens ?? 4096,
    };

    if (input.tools?.length) body.tools = OpenAIResponsesProvider.toTools(input.tools);
    if (input.responseFormat === 'json') {
      body.text = { format: { type: 'json_object' } };
    }

    // Do not forward tenantId, chatId, contact IDs, names, or other AURA
    // identifiers as OpenAI metadata. Those identifiers are useful inside
    // AURA, but add no model value and would increase third-party exposure.
    const response = await fetch(`${this.baseUrl}/responses`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(90_000),
    });

    if (!response.ok) {
      // Never copy the provider's response body into an application error.
      // Provider bodies can contain request echoes, customer text, or other
      // sensitive diagnostics. Keep only the status for safe classification.
      throw new Error(`openai HTTP ${response.status}`);
    }

    const payload = (await response.json()) as ResponsesPayload;
    const output = Array.isArray(payload.output) ? payload.output : [];

    const toolCalls: ResponsesFunctionCall[] = output
      .filter((item) => item.type === 'function_call')
      .map((item) => {
        if (!item.name || !item.call_id || typeof item.arguments !== 'string') {
          throw new Error('OpenAI returned an invalid function call item');
        }
        let args: Record<string, unknown>;
        try {
          const parsed = JSON.parse(item.arguments) as unknown;
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('function arguments are not an object');
          }
          args = parsed as Record<string, unknown>;
        } catch {
          throw new Error(`OpenAI returned invalid JSON arguments for tool ${item.name}`);
        }
        return { name: item.name, args, callId: item.call_id };
      });

    const text = output
      .filter((item) => item.type === 'message' && Array.isArray(item.content))
      .flatMap((item) => item.content ?? [])
      .filter((part) => part.type === 'output_text' && typeof part.text === 'string')
      .map((part) => part.text!.trim())
      .filter(Boolean)
      .join('\n')
      .trim();

    // Responses keeps reasoning as distinct output items. We only extract
    // `output_text`, so internal reasoning is never relayed to WhatsApp.
    if (text && looksLikeRawReasoningTrace(text)) {
      throw new Error('openai response looked like a raw internal reasoning trace - refusing to relay it');
    }
    if (!text && toolCalls.length === 0) {
      throw new Error('openai returned an empty response');
    }

    const result: {
      provider: string;
      text: string;
      usage?: { inputTokens?: number; outputTokens?: number };
      toolCalls?: GatewayToolCall[];
    } = {
      provider: this.name,
      text,
    };
    if (toolCalls.length) result.toolCalls = toolCalls as GatewayToolCall[];

    if (payload.usage) {
      result.usage = {
        ...(payload.usage.input_tokens !== undefined && { inputTokens: payload.usage.input_tokens }),
        ...(payload.usage.output_tokens !== undefined && { outputTokens: payload.usage.output_tokens }),
      };
    }

    return result;
  }
}

interface ProviderMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

type ProviderGenerateInput = {
  tenantId: string;
  operation: string;
  messages: ProviderMessage[];
  media?: GatewayMedia[];
  responseFormat?: 'text' | 'json';
  maxOutputTokens?: number;
  temperature?: number;
  tools?: GatewayToolDefinition[];
  pendingToolCalls?: GatewayToolCall[];
  toolResponses?: GatewayToolResponse[];
};
