import type { AIProviderAdapter, AIProviderToolDefinition, AIProviderToolCall, AIProviderToolResponse } from '../../domain/platform/contracts.js';
import { ProviderConfigRejectedError } from '../../domain/platform/contracts.js';

export { ProviderConfigRejectedError };

export interface GatewayMedia { mimeType: string; url?: string; base64Data?: string; }
export interface GatewayMessage { role: 'system' | 'user' | 'assistant'; content: string; }
export type GatewayToolDefinition = AIProviderToolDefinition;
export type GatewayToolCall = AIProviderToolCall;
export type GatewayToolResponse = AIProviderToolResponse;
export interface GatewayRequest {
  tenantId: string;
  operation: string;
  messages: GatewayMessage[];
  media?: GatewayMedia[];
  responseFormat?: 'text' | 'json';
  preferredProvider?: string;
  providerAllowlist?: string[];
  maxOutputTokens?: number;
  temperature?: number;
  /** Tools available to the model this turn. Providers that don't advertise functionCalling capability are excluded from eligibility when present. */
  tools?: GatewayToolDefinition[];
  /** The exact tool call(s) being answered - present only on a follow-up call after the caller executed a tool the model requested. Must be paired with toolResponses. */
  pendingToolCalls?: GatewayToolCall[];
  toolResponses?: GatewayToolResponse[];
}
export interface GatewayResponse {
  provider: string;
  model: string;
  text: string;
  usage?: { inputTokens?: number; outputTokens?: number };
  attemptedProviders: string[];
  /** Present instead of (or alongside a possibly-empty) text when the model wants to call a tool. The caller decides whether/how to execute it - the gateway never executes anything itself. */
  toolCalls?: GatewayToolCall[];
}
export interface RegisteredAiProvider extends AIProviderAdapter { model: string; priority: number; }

const MAX_MESSAGES = 64;
const MAX_MESSAGE_CHARS = 20_000;
const MAX_MEDIA_ITEMS = 8;
const MAX_MEDIA_BASE64_CHARS = 12_000_000;
const MAX_OUTPUT_TOKENS = 16_384;

/**
 * Real, live-reproduced quirk (found 2026-09-02 debugging a "bad request"
 * report from BuildAgentWizard's custom-description parsing): Gemini
 * sometimes wraps JSON-mode output in a ```json ... ``` markdown fence
 * even with responseMimeType explicitly set to 'application/json' - the
 * documented API contract that's supposed to prevent exactly this. Worse,
 * it showed up specifically on the *reduced* retry path
 * (generateReduced(), used after the primary request got rejected with a
 * bare, field-less 400 INVALID_ARGUMENT) - that path sends no JSON-mode
 * config at all by design (see generateReduced's own doc comment: the
 * literal bare-minimum shape every model must support), so a caller that
 * asked for JSON got free-form prose back, unstripped, and JSON.parse()
 * below threw. Applied here, centrally, to every provider's text on every
 * path (not duplicated per-provider) so this protects whichever provider
 * is eligible, present or future - a caller that never asked for JSON
 * (responseFormat left as 'text') is never touched.
 */
function stripJsonMarkdownFence(text: string): string {
  const fenced = text.match(/^```(?:json)?\s*\n([\s\S]*?)\n?```\s*$/i);
  return fenced ? fenced[1]!.trim() : text;
}

function mediaRequires(capabilities: Awaited<ReturnType<RegisteredAiProvider['capabilities']>>, media: GatewayMedia[]): string | null {
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
  if (request.maxOutputTokens !== undefined && (!Number.isInteger(request.maxOutputTokens) || request.maxOutputTokens < 1 || request.maxOutputTokens > MAX_OUTPUT_TOKENS)) throw new Error(`maxOutputTokens must be an integer between 1 and ${MAX_OUTPUT_TOKENS}`);
  if (request.temperature !== undefined && (request.temperature < 0 || request.temperature > 2)) throw new Error('temperature must be between 0 and 2');
  if (request.tools !== undefined) {
    if (request.tools.length === 0) throw new Error('AI gateway tools array must not be empty when provided');
    for (const tool of request.tools) {
      if (!tool.name.trim()) throw new Error('AI gateway tool definition requires a name');
    }
  }
  // A follow-up call answering a tool call needs both halves - one without
  // the other is a caller bug (either "answering nothing" or "a call the
  // model made with no answer"), not a state the gateway should try to
  // guess its way through.
  if ((request.pendingToolCalls === undefined) !== (request.toolResponses === undefined)) {
    throw new Error('AI gateway requires pendingToolCalls and toolResponses together, or neither');
  }
}

export class AiGateway {
  private readonly providers = new Map<string, RegisteredAiProvider>();
  register(provider: RegisteredAiProvider): void { if (this.providers.has(provider.name)) throw new Error(`AI provider "${provider.name}" is already registered`); this.providers.set(provider.name, provider); }
  registerMany(providers: RegisteredAiProvider[]): void { for (const provider of providers) this.register(provider); }
  unregister(providerName: string): boolean { return this.providers.delete(providerName); }
  clear(): void { this.providers.clear(); }
  listProviders(): Array<{ name: string; model: string; priority: number }> { return [...this.providers.values()].sort((a,b) => a.priority-b.priority || a.name.localeCompare(b.name)).map((provider) => ({ name: provider.name, model: provider.model, priority: provider.priority })); }
  async health(): Promise<Record<string, boolean>> {
    const entries = await Promise.all([...this.providers.values()].map(async (provider) => { try { const capabilities = await provider.capabilities(); return [provider.name, capabilities.text] as const; } catch { return [provider.name, false] as const; } }));
    return Object.fromEntries(entries);
  }
  async generate(request: GatewayRequest): Promise<GatewayResponse> {
    validateRequest(request);
    const eligible = [...this.providers.values()].filter((provider) => !request.providerAllowlist || request.providerAllowlist.includes(provider.name)).sort((a,b) => { if (request.preferredProvider === a.name) return -1; if (request.preferredProvider === b.name) return 1; return a.priority-b.priority; });
    if (eligible.length === 0) throw new Error('No eligible AI providers are registered');
    const attemptedProviders: string[] = []; const failures: string[] = [];
    for (const provider of eligible) {
      attemptedProviders.push(provider.name);
      try {
        const capabilities = await provider.capabilities();
        if (!capabilities.text) throw new Error('provider does not advertise text generation');
        if (request.media?.length) { const mediaError = mediaRequires(capabilities, request.media); if (mediaError) throw new Error(mediaError); }
        // Never sent to a provider that can't honour it - a provider silently
        // ignoring a declared tool and answering in plain text would look
        // like a working reply while actually dropping the caller's tool
        // contract entirely.
        if (request.tools?.length && !capabilities.functionCalling) throw new Error('provider does not advertise function calling');
        const providerInput: Parameters<AIProviderAdapter['generate']>[0] = { tenantId: request.tenantId, operation: request.operation, messages: request.messages };
        if (request.media !== undefined) providerInput.media = request.media;
        if (request.responseFormat !== undefined) providerInput.responseFormat = request.responseFormat;
        if (request.maxOutputTokens !== undefined) providerInput.maxOutputTokens = request.maxOutputTokens;
        if (request.temperature !== undefined) providerInput.temperature = request.temperature;
        if (request.tools !== undefined) providerInput.tools = request.tools;
        if (request.pendingToolCalls !== undefined) providerInput.pendingToolCalls = request.pendingToolCalls;
        if (request.toolResponses !== undefined) providerInput.toolResponses = request.toolResponses;
        const response = await provider.generate(providerInput);
        let text = response.text.trim();
        const toolCalls = response.toolCalls?.length ? response.toolCalls : undefined;
        // A tool-call response legitimately has no text yet - the model is
        // asking for information before it can answer, not failing to answer.
        if (!text && !toolCalls) throw new Error('provider returned an empty response');
        if (request.responseFormat === 'json' && text) {
          text = stripJsonMarkdownFence(text);
          try { JSON.parse(text); } catch { throw new Error('provider returned invalid JSON for a JSON-formatted request'); }
        }
        const result: GatewayResponse = { provider: response.provider, model: provider.model, text, attemptedProviders };
        if (response.usage !== undefined) result.usage = response.usage;
        if (toolCalls) result.toolCalls = toolCalls;
        return result;
      } catch (error) {
        // A reduced retry strips every optional field down to the bare
        // essentials (see GeminiProvider.generateReduced) - safe when the
        // caller only wanted tone/length tuning, but never safe when the
        // caller explicitly required tool-calling: silently answering in
        // plain text instead of honouring (or correctly failing) a tool
        // contract would look like a working reply while actually dropping
        // it. Skip the reduced retry in that case and fall through to
        // ordinary failover to the next eligible provider instead.
        if (error instanceof ProviderConfigRejectedError && provider.generateReduced && !request.tools?.length) {
          try {
            const reducedInput: Parameters<NonNullable<AIProviderAdapter['generateReduced']>>[0] = { tenantId: request.tenantId, operation: request.operation, messages: request.messages };
            if (request.maxOutputTokens !== undefined) reducedInput.maxOutputTokens = request.maxOutputTokens;
            const reducedResponse = await provider.generateReduced(reducedInput);
            let text = reducedResponse.text.trim();
            if (!text) throw new Error('provider returned an empty response on the reduced retry');
            // generateReduced() sends no JSON-mode config at all by design
            // (its own bare-minimum contract) - a caller that wanted JSON
            // still needs this on the reduced path, arguably more than the
            // primary one, since nothing told the model to skip markdown.
            if (request.responseFormat === 'json') {
              text = stripJsonMarkdownFence(text);
              try { JSON.parse(text); } catch { throw new Error('provider returned invalid JSON for a JSON-formatted request on the reduced retry'); }
            }
            const result: GatewayResponse = { provider: reducedResponse.provider, model: provider.model, text, attemptedProviders };
            if (reducedResponse.usage !== undefined) result.usage = reducedResponse.usage;
            return result;
          } catch (reducedError) {
            failures.push(`${provider.name}: config rejected (${error.message}); reduced retry also failed: ${reducedError instanceof Error ? reducedError.message : String(reducedError)}`);
            continue;
          }
        }
        failures.push(`${provider.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    throw new Error(`All eligible AI providers failed. ${failures.join(' | ')}`);
  }
}

export const aiGateway = new AiGateway();
