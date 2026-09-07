import { aiGateway } from './aiGateway.js';
import { registerDefaultAiProviders } from './providerAdapters.js';
import { OpenAIResponsesProvider } from './openaiResponsesProvider.js';

let initialized = false;

/** Initialise the process-local provider registry exactly once. Missing credentials are not treated as failures. */
export function initializeAiGateway(): void {
  if (initialized) return;
  registerDefaultAiProviders(aiGateway);

  // The legacy OpenAI-compatible adapter remains available in providerAdapters
  // for compatibility, but the real OpenAI deployment must use the native
  // Responses API. It provides explicit function-call IDs, clean separation
  // between reasoning items and visible output, and store:false for customer
  // conversations. Replace the legacy registration rather than maintaining
  // two independently configured OpenAI providers in the routing chain.
  if (process.env.OPENAI_API_KEY) {
    aiGateway.unregister('openai');
    aiGateway.register(new OpenAIResponsesProvider());
  }

  initialized = true;
}

export function getAiGateway() {
  initializeAiGateway();
  return aiGateway;
}
