import type { Content } from '@google/genai';
import { ApiError } from '@google/genai';
import { getGeminiClient } from '../geminiClient.js';
import * as gooseService from '../gooseService.js';
import type { RegisteredAiProvider, GatewayMedia, GatewayToolDefinition, GatewayToolCall, GatewayToolResponse } from './aiGateway.js';
import { aiGateway, ProviderConfigRejectedError } from './aiGateway.js';
import { looksLikeRawReasoningTrace } from './reasoningLeakGuard.js';

/**
 * Translates a bare Gemini 400 into the gateway's generic
 * ProviderConfigRejectedError - real evidence (the "Test Gemini connection"
 * diagnostic) showed this exact status rejecting the temperature +
 * thinkingConfig combination outright for at least one deployed model/key,
 * with no field-level detail to act on beyond the status code. Any other
 * error (auth, capacity, network) passes through unchanged so AiGateway's
 * ordinary failover still applies to it.
 */
function asConfigRejection(error: unknown): never {
  if (error instanceof ApiError && error.status === 400) {
    throw new ProviderConfigRejectedError(`Gemini rejected the request configuration: ${error.message}`);
  }
  throw error;
}

export interface ProviderGenerateInput {
  tenantId: string;
  operation: string;
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  media?: GatewayMedia[];
  responseFormat?: 'text' | 'json';
  maxOutputTokens?: number;
  temperature?: number;
  tools?: GatewayToolDefinition[];
  /** Present only on a follow-up call answering a tool call the model just made - must be paired with toolResponses, same index order. */
  pendingToolCalls?: GatewayToolCall[];
  toolResponses?: GatewayToolResponse[];
}

type ProviderCapabilities = Awaited<ReturnType<RegisteredAiProvider['capabilities']>>;

function buildPrompt(input: ProviderGenerateInput): string {
  return `Operation: ${input.operation}\n\n${input.messages.map((m) => `${m.role.toUpperCase()}:\n${m.content}`).join('\n\n')}`;
}

export class GeminiProvider implements RegisteredAiProvider {
  readonly name = 'gemini';
  readonly model: string;
  readonly priority: number;

  constructor(
    model = process.env.GEMINI_GATEWAY_MODEL || process.env.GEMINI_REPLY_MODEL || process.env.GEMINI_MODEL || 'gemini-3.5-flash',
    priority = 10,
  ) {
    this.model = model;
    this.priority = priority;
  }

  async capabilities(): Promise<ProviderCapabilities> {
    const available = getGeminiClient() !== null;
    return { text: available, vision: available, audio: false, video: false, documents: false, functionCalling: available };
  }

  async generate(input: ProviderGenerateInput) {
    const client = getGeminiClient();
    if (!client) throw new Error('GEMINI_API_KEY is not configured');
    if (input.tools?.length) return this.generateWithTools(client, input);

    const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [{ text: buildPrompt(input) }];
    for (const media of input.media ?? []) {
      if (!media.mimeType.startsWith('image/')) throw new Error(`Gemini provider cannot currently process ${media.mimeType}`);
      if (!media.base64Data) throw new Error('Gemini image input requires base64Data from AURA media storage');
      parts.push({ inlineData: { mimeType: media.mimeType, data: media.base64Data } });
    }

    // thinkingBudget: 0 is applied unconditionally, not exposed as a caller
    // option - every current caller of Gemini in this codebase (aiReplyService,
    // the callers migrating onto this gateway) explicitly disables it for the
    // same reason: a short reply/draft doesn't need internal "thinking"
    // tokens competing with maxOutputTokens for the same budget.
    const config: { maxOutputTokens: number; responseMimeType: string; thinkingConfig: { thinkingBudget: number }; temperature?: number } = {
      maxOutputTokens: input.maxOutputTokens ?? 1024,
      responseMimeType: input.responseFormat === 'json' ? 'application/json' : 'text/plain',
      thinkingConfig: { thinkingBudget: 0 },
    };
    if (input.temperature !== undefined) config.temperature = input.temperature;

    const response = await client.models
      .generateContent({ model: this.model, contents: [{ role: 'user', parts }], config })
      .catch(asConfigRejection);
    const text = response.text?.trim() ?? '';
    if (!text) throw new Error('Gemini returned an empty response');
    return { provider: this.name, text };
  }

  /**
   * The same-provider fallback AiGateway calls at most once, only after
   * generate() threw ProviderConfigRejectedError - the literal bare-minimum
   * request real models must support (system instruction + conversation
   * turns + maxOutputTokens, nothing else). No thinkingConfig override, no
   * temperature, no tools: this mirrors aiReplyService.ts's own
   * production-incident-driven retry byte for byte, because that retry is
   * the only evidence this bare shape is actually safe.
   */
  async generateReduced(input: {
    tenantId: string;
    operation: string;
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
    maxOutputTokens?: number;
  }) {
    const client = getGeminiClient();
    if (!client) throw new Error('GEMINI_API_KEY is not configured');
    const systemInstruction = input.messages
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n\n');
    const contents: Content[] = input.messages
      .filter((message) => message.role !== 'system')
      .map((message) => ({
        role: message.role === 'assistant' ? ('model' as const) : ('user' as const),
        parts: [{ text: message.content }],
      }));
    const config = { systemInstruction, maxOutputTokens: input.maxOutputTokens ?? 1024 };
    const response = await client.models.generateContent({ model: this.model, contents, config });
    const text = response.text?.trim() ?? '';
    if (!text) throw new Error('Gemini returned an empty response on the reduced retry');
    return { provider: this.name, text };
  }

  /**
   * A deliberately separate path from the flattened-single-blob buildPrompt()
   * above - tool-calling needs a real multi-turn `contents` array (system
   * instruction split out, roles preserved, and - on a follow-up call -
   * the exact functionCall/functionResponse turn pair the model needs to see
   * to answer) exactly like aiReplyService.ts's own resolveToolCalls
   * already builds by hand. Kept isolated so the three callers already
   * migrated onto the non-tool path (replySuggestionService, marketingAiService,
   * emailService) are never affected by this branch.
   */
  private async generateWithTools(client: NonNullable<ReturnType<typeof getGeminiClient>>, input: ProviderGenerateInput) {
    if (input.media?.length) throw new Error('Gemini tool-calling path does not currently support media inputs');
    if ((input.pendingToolCalls?.length ?? 0) !== (input.toolResponses?.length ?? 0)) {
      throw new Error('Gemini provider requires matching pendingToolCalls and toolResponses');
    }
    const systemInstruction = input.messages
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n\n');
    const contents: Content[] = input.messages
      .filter((message) => message.role !== 'system')
      .map((message) => ({
        role: message.role === 'assistant' ? ('model' as const) : ('user' as const),
        parts: [{ text: message.content }],
      }));
    if (input.pendingToolCalls?.length) {
      for (const [index, call] of input.pendingToolCalls.entries()) {
        const toolResponse = input.toolResponses![index]!;
        contents.push({ role: 'model', parts: [{ functionCall: { name: call.name, args: call.args } }] });
        contents.push({ role: 'user', parts: [{ functionResponse: { name: toolResponse.name, response: toolResponse.response } }] });
      }
    }
    const config: {
      systemInstruction: string;
      maxOutputTokens: number;
      thinkingConfig: { thinkingBudget: number };
      temperature?: number;
      tools: Array<{ functionDeclarations: GatewayToolDefinition[] }>;
    } = {
      systemInstruction,
      maxOutputTokens: input.maxOutputTokens ?? 1024,
      thinkingConfig: { thinkingBudget: 0 },
      tools: [{ functionDeclarations: input.tools! }],
    };
    if (input.temperature !== undefined) config.temperature = input.temperature;
    let response;
    try {
      response = await client.models.generateContent({ model: this.model, contents, config });
    } catch (error) {
      // A vague 400 with no field-level detail is a real, recurring Gemini
      // quirk this codebase has already hit twice (see aiReplyService.ts's
      // own retry) - both prior cases isolated thinkingConfig as (part of)
      // the trigger. AiGateway deliberately refuses to drop `tools` on
      // retry here (a caller requiring tool-calling must never silently
      // get a plain-text answer that looks like it honoured the tool
      // contract when it didn't - see aiGateway.ts's own comment), but
      // dropping only thinkingConfig carries no such risk: it's a
      // reasoning-budget hint, not part of what the model is being asked
      // to do. One retry, tools/temperature/systemInstruction unchanged.
      if (!(error instanceof ApiError) || error.status !== 400) throw error;
      const { thinkingConfig: _unused, ...configWithoutThinking } = config;
      response = await client.models.generateContent({ model: this.model, contents, config: configWithoutThinking }).catch(asConfigRejection);
    }
    const toolCalls: GatewayToolCall[] | undefined = response.functionCalls?.length
      ? response.functionCalls.map((call) => ({ name: call.name ?? '', args: (call.args ?? {}) as Record<string, unknown> }))
      : undefined;
    const text = response.text?.trim() ?? '';
    if (!text && !toolCalls?.length) throw new Error('Gemini returned an empty response');
    const result: { provider: string; text: string; toolCalls?: GatewayToolCall[] } = { provider: this.name, text };
    if (toolCalls?.length) result.toolCalls = toolCalls;
    return result;
  }
}

abstract class OpenAICompatibleProvider implements RegisteredAiProvider {
  abstract readonly name: string;
  readonly model: string;
  readonly priority: number;
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly extraHeaders: Record<string, string>;

  protected constructor(options: {
    name: string;
    model: string;
    priority: number;
    apiKey: string | undefined;
    baseUrl: string;
    extraHeaders: Record<string, string>;
  }) {
    this.model = options.model;
    this.priority = options.priority;
    this.apiKey = options.apiKey;
    const parsed = new URL(options.baseUrl);
    if (parsed.protocol !== 'https:') throw new Error(`${options.name} base URL must use HTTPS`);
    this.baseUrl = parsed.toString().replace(/\/$/, '');
    this.extraHeaders = options.extraHeaders;
  }

  async capabilities(): Promise<ProviderCapabilities> {
    return { text: Boolean(this.apiKey && this.model), vision: false, audio: false, video: false, documents: false, functionCalling: false };
  }

  async generate(input: ProviderGenerateInput) {
    if (!this.apiKey) throw new Error(`${this.name.toUpperCase()} API key is not configured`);
    if (!this.model) throw new Error(`${this.name.toUpperCase()} model is not configured`);
    if (input.media?.length) throw new Error(`${this.name} adapter currently accepts text only through the safe baseline path`);
    if (input.tools?.length) throw new Error(`${this.name} adapter does not support tool calling`);

    const doFetch = () =>
      fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}`, ...this.extraHeaders },
        body: JSON.stringify({
          model: this.model,
          messages: input.messages,
          // 1024 is enough for an actual short WhatsApp reply, but some
          // OpenAI-compatible providers (reasoning models in particular) spend
          // a real chunk of this same budget on an internal <thinking> pass
          // before ever writing the visible answer - a tight ceiling makes a
          // truncated-mid-thought response common, not rare. The real reply
          // still comes out short regardless of this ceiling, since the system
          // instruction already asks for a concise answer - this just gives
          // the model room to finish reasoning first.
          max_tokens: input.maxOutputTokens ?? 4096,
          ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
          ...(input.responseFormat === 'json' ? { response_format: { type: 'json_object' } } : {}),
        }),
        signal: AbortSignal.timeout(90_000),
      });

    // One short retry for a genuine network-level failure only (fetch()
    // itself throwing - DNS/connection-reset/handshake failure, never an
    // HTTP error response, which a retry usually can't fix anyway).
    // Confirmed live: this dev environment's own network relay is
    // intermittently flaky (the same request that failed to connect at all
    // succeeded cleanly a few seconds later, and a plain request to
    // google.com failed the exact same way at the exact same moment) - a
    // blip lasting a couple of seconds, not a real provider outage, so a
    // short, bounded retry is worth the latency it costs.
    let response: Response;
    try {
      response = await doFetch();
    } catch (firstError) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      try {
        response = await doFetch();
      } catch {
        throw firstError;
      }
    }
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`${this.name} HTTP ${response.status}${body ? `: ${body.slice(0, 500)}` : ''}`);
    }
    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string | null }; finish_reason?: string | null }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const choice = payload.choices?.[0];
    /**
     * A reasoning model that gets cut off mid-<thinking> before it ever
     * reaches a real answer puts that in-progress internal reasoning
     * straight into this same `content` field - confirmed live (a
     * generation cut short by the token limit returned the raw chain-of-
     * thought, including the literal system-prompt/persona text, as if it
     * were the finished reply). `finish_reason: 'length'` is the one
     * reliable signal that happened - unlike Goose's CLI path, which
     * already separates a `thinking`-typed part from a real `text` part
     * itself, this raw completions response has no such split to lean on,
     * so a truncated response can never be trusted as a real answer here.
     */
    if (choice?.finish_reason === 'length') {
      throw new Error(`${this.name} response was truncated before finishing (finish_reason: length) - not safe to treat as a real answer, may contain raw internal reasoning`);
    }
    const text = choice?.message?.content?.trim() ?? '';
    if (!text) throw new Error(`${this.name} returned an empty response`);
    // A separate, real incident from the truncation case above: the
    // generation completed normally (finish_reason: 'stop'), but the
    // model's own chosen, intentional answer WAS its internal chain-of-
    // thought narrative - happened when a customer asked meta-questions
    // about "your thinking process." Checks the literal output rather than
    // trusting the system prompt's instruction not to do this, which did
    // not reliably hold under direct questioning.
    if (looksLikeRawReasoningTrace(text)) {
      throw new Error(`${this.name} response looked like a raw internal reasoning trace, not a real answer - refusing to relay it`);
    }
    const result: { provider: string; text: string; usage?: { inputTokens?: number; outputTokens?: number } } = { provider: this.name, text };
    const usage: { inputTokens?: number; outputTokens?: number } = {};
    if (payload.usage?.prompt_tokens !== undefined) usage.inputTokens = payload.usage.prompt_tokens;
    if (payload.usage?.completion_tokens !== undefined) usage.outputTokens = payload.usage.completion_tokens;
    if (Object.keys(usage).length > 0) result.usage = usage;
    return result;
  }
}

export class OpenAIProvider extends OpenAICompatibleProvider {
  readonly name = 'openai';
  constructor(model = process.env.OPENAI_GATEWAY_MODEL || 'gpt-5-mini', priority = 20) {
    super({
      name: 'openai',
      model,
      priority,
      apiKey: process.env.OPENAI_API_KEY,
      baseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
      extraHeaders: {},
    });
  }
}

export class OpenRouterProvider extends OpenAICompatibleProvider {
  readonly name = 'openrouter';
  constructor(model = process.env.OPENROUTER_GATEWAY_MODEL || process.env.OPENROUTER_MODEL || '', priority = 30) {
    const extraHeaders: Record<string, string> = {};
    if (process.env.OPENROUTER_HTTP_REFERER) extraHeaders['HTTP-Referer'] = process.env.OPENROUTER_HTTP_REFERER;
    if (process.env.OPENROUTER_X_TITLE) extraHeaders['X-Title'] = process.env.OPENROUTER_X_TITLE;
    super({
      name: 'openrouter',
      model,
      priority,
      apiKey: process.env.OPENROUTER_API_KEY,
      baseUrl: process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
      extraHeaders,
    });
  }
}

/**
 * The "emergency text-only reply engine" (see gooseService.ts's own prompt
 * framing) - a last-resort fallback, deliberately lowest priority in the
 * chain, for when every real provider has failed.
 *
 * A single global secret, exactly like Gemini/OpenAI/OpenRouter -
 * GOOSE_SERVICE_URL/GOOSE_SERVICE_API_KEY, developer-controlled only. This
 * used to also resolve a per-business override from
 * IntegrationSettingsRepository, letting any business owner point their
 * own Goose failover at an arbitrary third-party URL that would receive
 * real customer conversation text - a genuine data-exfiltration surface,
 * not just an inconsistency with how every other provider is configured.
 * Removed entirely (Section 117-122 security review): Goose is now
 * provisioned the same way as every other provider, and capabilities()'s
 * static env-var check is now the real source of truth too, not just a
 * coarse approximation of a per-tenant lookup generate() used to also do.
 *
 * Never claims 'generated' without a real response: gooseService.generateResponse
 * already fails closed to {status:'unavailable', reason} on any missing
 * config, network error, HTTP error, or empty body - this adapter surfaces
 * that reason as a thrown Error, exactly like every other provider's
 * failure path, so AiGateway's own failure log and failover behavior treat
 * it identically.
 */
export class GooseProvider implements RegisteredAiProvider {
  readonly name = 'goose';
  readonly model = 'goose-failover';
  readonly priority: number;

  constructor(priority = 40) {
    this.priority = priority;
  }

  async capabilities(): Promise<ProviderCapabilities> {
    const available = gooseService.getCapabilities().configured;
    return { text: available, vision: false, audio: false, video: false, documents: false, functionCalling: false };
  }

  async generate(input: ProviderGenerateInput) {
    if (input.media?.length) throw new Error('Goose provider is text-only and cannot process media');
    if (input.tools?.length) throw new Error('Goose provider does not support tool calling');
    if (!gooseService.getCapabilities().configured) {
      throw new Error('Goose failover is not configured');
    }

    const systemMessages = input.messages.filter((message) => message.role === 'system').map((message) => message.content);
    const conversation = input.messages.filter((message) => message.role !== 'system');

    const result = await gooseService.generateResponse({
      systemInstruction: systemMessages.join('\n\n'),
      contents: conversation.map((message) => ({
        role: message.role === 'assistant' ? ('model' as const) : ('user' as const),
        parts: [{ text: message.content }],
      })),
    });

    if (result.status === 'unavailable') throw new Error(result.reason);
    return { provider: this.name, text: result.text };
  }
}

export function registerDefaultAiProviders(gateway = aiGateway): void {
  const providers: RegisteredAiProvider[] = [];
  if (process.env.GEMINI_API_KEY) providers.push(new GeminiProvider());
  if (process.env.OPENAI_API_KEY) providers.push(new OpenAIProvider());
  if (process.env.OPENROUTER_API_KEY && (process.env.OPENROUTER_GATEWAY_MODEL || process.env.OPENROUTER_MODEL)) {
    providers.push(new OpenRouterProvider());
  }
  if (process.env.GOOSE_SERVICE_URL) providers.push(new GooseProvider());
  for (const provider of providers) {
    if (!gateway.listProviders().some((entry) => entry.name === provider.name)) gateway.register(provider);
  }
}
