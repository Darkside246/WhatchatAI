import { propertyMaintenanceTriageSkill, skillRegistry } from './skillRegistry.js';
import { moduleRegistry, propertyOperationsModule } from './moduleRegistry.js';
import { initializeAiGateway } from '../ai/aiGatewayBootstrap.js';
import { initializeAgentRuntimes } from '../agents/agentRuntimeService.js';

let initialized = false;

/**
 * Opt-in bootstrap for the new platform layer. It does not alter the existing
 * WhatsApp responder, router, or dispatcher unless the caller explicitly
 * invokes it. This lets the platform be exercised in isolation before the
 * live communication path is switched over.
 */
export function initializePlatformFoundation(): void {
  if (initialized) return;

  initializeAiGateway();
  initializeAgentRuntimes();

  if (!moduleRegistry.get(propertyOperationsModule.id)) {
    moduleRegistry.register(propertyOperationsModule);
  }
  if (!skillRegistry.get(propertyMaintenanceTriageSkill.id)) {
    skillRegistry.register(propertyMaintenanceTriageSkill);
  }

  initialized = true;
}
