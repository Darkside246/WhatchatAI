import { getGeminiClient } from '../geminiClient.js';
import * as gooseService from '../gooseService.js';
import { IntegrationSettingsRepository } from '../../repositories/integrationSettingsRepository.js';
import { pool } from '../../db/pool.js';
import type { RegisteredAiProvider, GatewayMedia } from './aiGateway.js';
import { aiGateway } from './aiGateway.js';

export interface ProviderGenerateInput {
  tenantId: string;
  operation: string;
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  media?: GatewayMedia[];
  responseFormat?: 'text' | 'json';
  maxOutputTokens?: number;
  temperature?: number;
}

type ProviderCapabilities = Awaited<ReturnType<RegisteredAiProvider['capabilities']>>;
function buildPrompt(input: ProviderGenerateInput): string { return `Operation: ${input.operation}\n\n${input.messages.map((m) => `${m.role.toUpperCase()}:\n${m.content}`).join('\n\n')}`; }

export class GeminiProvider implements RegisteredAiProvider {
  readonly name='gemini'; readonly model:string; readonly priority:number;
  constructor(model=process.env.GEMINI_GATEWAY_MODEL||process.env.GEMINI_REPLY_MODEL||process.env.GEMINI_MODEL||'gemini-3.5-flash', priority=10){this.model=model;this.priority=priority;}
  async capabilities():Promise<ProviderCapabilities>{const available=getGeminiClient()!==null;return{text:available,vision:available,audio:false,video:false,documents:false};}
  async generate(input:ProviderGenerateInput){const client=getGeminiClient();if(!client)throw new Error('GEMINI_API_KEY is not configured');const parts:Array<{text:string}|{inlineData:{mimeType:string;data:string}}>=[{text:buildPrompt(input)}];for(const media of input.media??[]){if(!media.mimeType.startsWith('image/'))throw new Error(`Gemini provider cannot currently process ${media.mimeType}`);if(!media.base64Data)throw new Error('Gemini image input requires base64Data from WhatchatAI media storage');parts.push({inlineData:{mimeType:media.mimeType,data:media.base64Data}});}
    // thinkingBudget: 0 is applied unconditionally, not exposed as a caller
    // option - every current caller of Gemini in this codebase (aiReplyService,
    // the callers migrating onto this gateway) explicitly disables it for the
    // same reason: a short reply/draft doesn't need internal "thinking"
    // tokens competing with maxOutputTokens for the same budget.
    const config:{maxOutputTokens:number;responseMimeType:string;thinkingConfig:{thinkingBudget:number};temperature?:number}={maxOutputTokens:input.maxOutputTokens??1024,responseMimeType:input.responseFormat==='json'?'application/json':'text/plain',thinkingConfig:{thinkingBudget:0}};
    if(input.temperature!==undefined)config.temperature=input.temperature;
    const response=await client.models.generateContent({model:this.model,contents:[{role:'user',parts}],config});const text=response.text?.trim()??'';if(!text)throw new Error('Gemini returned an empty response');return{provider:this.name,text};}
}

abstract class OpenAICompatibleProvider implements RegisteredAiProvider {
  abstract readonly name:string; readonly model:string; readonly priority:number; private readonly apiKey:string|undefined; private readonly baseUrl:string; private readonly extraHeaders:Record<string,string>;
  protected constructor(options:{name:string;model:string;priority:number;apiKey:string|undefined;baseUrl:string;extraHeaders:Record<string,string>}){this.model=options.model;this.priority=options.priority;this.apiKey=options.apiKey;const parsed=new URL(options.baseUrl);if(parsed.protocol!=='https:')throw new Error(`${options.name} base URL must use HTTPS`);this.baseUrl=parsed.toString().replace(/\/$/,'');this.extraHeaders=options.extraHeaders;}
  async capabilities():Promise<ProviderCapabilities>{return{text:Boolean(this.apiKey&&this.model),vision:false,audio:false,video:false,documents:false};}
  async generate(input:ProviderGenerateInput){if(!this.apiKey)throw new Error(`${this.name.toUpperCase()} API key is not configured`);if(!this.model)throw new Error(`${this.name.toUpperCase()} model is not configured`);if(input.media?.length)throw new Error(`${this.name} adapter currently accepts text only through the safe baseline path`);const response=await fetch(`${this.baseUrl}/chat/completions`,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${this.apiKey}`,...this.extraHeaders},body:JSON.stringify({model:this.model,messages:input.messages,max_tokens:input.maxOutputTokens??1024,...(input.temperature!==undefined?{temperature:input.temperature}:{}),...(input.responseFormat==='json'?{response_format:{type:'json_object'}}:{})}),signal:AbortSignal.timeout(90_000)});if(!response.ok){const body=await response.text().catch(()=> '');throw new Error(`${this.name} HTTP ${response.status}${body?`: ${body.slice(0,500)}`:''}`);}const payload=(await response.json()) as{choices?:Array<{message?:{content?:string|null}}>;usage?:{prompt_tokens?:number;completion_tokens?:number}};const text=payload.choices?.[0]?.message?.content?.trim()??'';if(!text)throw new Error(`${this.name} returned an empty response`);const result:{provider:string;text:string;usage?:{inputTokens?:number;outputTokens?:number}}={provider:this.name,text};const usage:{inputTokens?:number;outputTokens?:number}={};if(payload.usage?.prompt_tokens!==undefined)usage.inputTokens=payload.usage.prompt_tokens;if(payload.usage?.completion_tokens!==undefined)usage.outputTokens=payload.usage.completion_tokens;if(Object.keys(usage).length>0)result.usage=usage;return result;}
}

export class OpenAIProvider extends OpenAICompatibleProvider{readonly name='openai';constructor(model=process.env.OPENAI_GATEWAY_MODEL||'gpt-5-mini',priority=20){super({name:'openai',model,priority,apiKey:process.env.OPENAI_API_KEY,baseUrl:process.env.OPENAI_BASE_URL||'https://api.openai.com/v1',extraHeaders:{}});}}
export class OpenRouterProvider extends OpenAICompatibleProvider{readonly name='openrouter';constructor(model=process.env.OPENROUTER_GATEWAY_MODEL||process.env.OPENROUTER_MODEL||'',priority=30){const extraHeaders:Record<string,string>={};if(process.env.OPENROUTER_HTTP_REFERER)extraHeaders['HTTP-Referer']=process.env.OPENROUTER_HTTP_REFERER;if(process.env.OPENROUTER_X_TITLE)extraHeaders['X-Title']=process.env.OPENROUTER_X_TITLE;super({name:'openrouter',model,priority,apiKey:process.env.OPENROUTER_API_KEY,baseUrl:process.env.OPENROUTER_BASE_URL||'https://openrouter.ai/api/v1',extraHeaders});}}

/**
 * The "emergency text-only reply engine" (see gooseService.ts's own prompt
 * framing) - a last-resort fallback, deliberately lowest priority in the
 * chain, for when every real provider has failed.
 *
 * Goose's configuration is NOT a single global secret like the other three
 * providers - it is per-business, resolved from IntegrationSettingsRepository
 * (a workspace can supply its own serviceUrl/apiKey, or turn failover off
 * entirely even when a global GOOSE_SERVICE_URL fallback exists). capabilities()
 * has no tenantId to check that with, so it reports only the coarse global
 * fallback signal - the same limitation OpenAI/OpenRouter's capabilities()
 * already has (a static env-var check, not a guarantee). generate() does the
 * real per-tenant lookup and is the actual source of truth; a business with
 * only per-tenant Goose config and no global GOOSE_SERVICE_URL will not be
 * offered this provider by AiGateway's eligibility filter today - a known,
 * narrow gap, not a silent one.
 *
 * Never claims 'generated' without a real response: gooseService.generateResponse
 * already fails closed to {status:'unavailable', reason} on any missing
 * config, disabled workspace setting, network error, HTTP error, or empty
 * body - this adapter surfaces that reason as a thrown Error, exactly like
 * every other provider's failure path, so AiGateway's own failure log and
 * failover behavior treat it identically.
 */
export class GooseProvider implements RegisteredAiProvider {
  readonly name = 'goose';
  readonly model = 'goose-failover';
  readonly priority: number;
  private readonly settingsRepository = new IntegrationSettingsRepository(pool);

  constructor(priority = 40) {
    this.priority = priority;
  }

  async capabilities(): Promise<ProviderCapabilities> {
    const available = gooseService.getCapabilities().configured;
    return { text: available, vision: false, audio: false, video: false, documents: false };
  }

  async generate(input: ProviderGenerateInput) {
    if (input.media?.length) throw new Error('Goose provider is text-only and cannot process media');

    // Workspace settings win over the global env fallback - a workspace
    // that has explicitly turned failover off must be honoured even when a
    // global GOOSE_SERVICE_URL is configured. This precedence used to live
    // in aiReplyService.ts's own tryGooseFallback; now that aiReplyService's
    // fallback routes through AiGateway instead of calling Goose directly,
    // this is the one place that logic needs to exist.
    const settings = await this.settingsRepository.getGooseResolved(input.tenantId).catch(() => null);
    if (settings && !settings.isEnabled) {
      throw new Error('Goose failover is turned off for this workspace');
    }
    const endpoint = settings?.isEnabled && settings.serviceUrl ? { serviceUrl: settings.serviceUrl, apiKey: settings.apiKey } : undefined;
    if (!endpoint && !gooseService.getCapabilities().configured) {
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
      endpoint,
    });

    if (result.status === 'unavailable') throw new Error(result.reason);
    return { provider: this.name, text: result.text };
  }
}

export function registerDefaultAiProviders(gateway=aiGateway):void{const providers:RegisteredAiProvider[]=[];if(process.env.GEMINI_API_KEY)providers.push(new GeminiProvider());if(process.env.OPENAI_API_KEY)providers.push(new OpenAIProvider());if(process.env.OPENROUTER_API_KEY&&(process.env.OPENROUTER_GATEWAY_MODEL||process.env.OPENROUTER_MODEL))providers.push(new OpenRouterProvider());if(process.env.GOOSE_SERVICE_URL)providers.push(new GooseProvider());for(const provider of providers){if(!gateway.listProviders().some((entry)=>entry.name===provider.name))gateway.register(provider);}}
