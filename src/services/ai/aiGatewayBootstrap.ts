import { aiGateway } from './aiGateway.js';
import { registerDefaultAiProviders } from './providerAdapters.js';

let initialized = false;

/** Initialise the process-local provider registry exactly once. Missing credentials are not treated as failures. */
export function initializeAiGateway(): void {
  if (initialized) return;
  registerDefaultAiProviders(aiGateway);
  initialized = true;
}

export function getAiGateway() {
  initializeAiGateway();
  return aiGateway;
}
