import { aiGateway } from './aiGateway.js';
import { GooseProvider, OpenRouterProvider, registerDefaultAiProviders } from './providerAdapters.js';
import { OpenAIResponsesProvider } from './openaiResponsesProvider.js';
import { CerebrasProvider, GroqProvider, MistralProvider } from './openaiCompatibleToolProviders.js';

let initialized = false;

/** Initialise the process-local provider registry exactly once. Missing credentials are not treated as failures. */
export function initializeAiGateway(): void {
  if (initialized) return;
  registerDefaultAiProviders(aiGateway);

  // Provider ordering is intentional. Goose remains a text-only emergency
  // fallback and must not consume a normal tool-capable turn while a real
  // agent provider is available. Lower priority numbers are tried first.
  //
  // Gemini       10 - existing primary
  // OpenAI       20 - native Responses API + tools
  // Groq         25 - OpenAI-compatible + tools
  // Cerebras     30 - OpenAI-compatible + tools
  // Mistral      35 - OpenAI-compatible + tools
  // OpenRouter   40 - existing text-only compatibility fallback
  // Goose        50 - terminal text-only emergency path
  //
  // The environment controls whether each provider exists at all. No API key
  // means no registration, so an unconfigured provider cannot accidentally
  // receive customer context.

  if (process.env.OPENAI_API_KEY) {
    aiGateway.unregister('openai');
    aiGateway.register(new OpenAIResponsesProvider(20));
  }

  if (process.env.GROQ_API_KEY) {
    aiGateway.unregister('groq');
    aiGateway.register(new GroqProvider(undefined, 25));
  }

  if (process.env.CEREBRAS_API_KEY) {
    aiGateway.unregister('cerebras');
    aiGateway.register(new CerebrasProvider(undefined, 30));
  }

  if (process.env.MISTRAL_API_KEY) {
    aiGateway.unregister('mistral');
    aiGateway.register(new MistralProvider(undefined, 35));
  }

  if (process.env.OPENROUTER_API_KEY && (process.env.OPENROUTER_GATEWAY_MODEL || process.env.OPENROUTER_MODEL)) {
    aiGateway.unregister('openrouter');
    aiGateway.register(new OpenRouterProvider(undefined, 40));
  }

  if (process.env.GOOSE_SERVICE_URL) {
    aiGateway.unregister('goose');
    aiGateway.register(new GooseProvider(50));
  }

  initialized = true;
}

export function getAiGateway() {
  initializeAiGateway();
  return aiGateway;
}
