import { propertyMaintenanceTriageSkill, skillRegistry } from './skillRegistry.js';
import { moduleRegistry, propertyOperationsModule } from './moduleRegistry.js';
import { initializeAiGateway } from '../ai/aiGatewayBootstrap.js';
import { initializeAgentRuntimes } from '../agents/agentRuntimeService.js';

let initialized = false;

/**
 * Initializes the new platform layer without changing the existing live
 * WhatsApp responder. Commercial capabilities remain disabled until their
 * explicit feature flags are enabled.
 */
export function initializePlatformFoundation(): void {
  if (initialized) return;

  initializeAiGateway();
  initializeAgentRuntimes();

  if (!moduleRegistry.get(propertyOperationsModule.id)) moduleRegistry.register(propertyOperationsModule);
  if (!skillRegistry.get(propertyMaintenanceTriageSkill.id)) skillRegistry.register(propertyMaintenanceTriageSkill);

  if (process.env.PROPERTY_OPERATIONS_ENABLED === 'true') {
    const existing = skillRegistry.get(propertyMaintenanceTriageSkill.id);
    if (existing && !existing.enabled) skillRegistry.enable(propertyMaintenanceTriageSkill.id);
  }

  initialized = true;
}
