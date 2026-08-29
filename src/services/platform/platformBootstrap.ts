import { propertyMaintenanceTriageSkill, skillRegistry } from './skillRegistry.js';
import { moduleRegistry, propertyOperationsModule } from './moduleRegistry.js';
import { initializeAiGateway } from '../ai/aiGatewayBootstrap.js';
import { initializeAgentRuntimes } from '../agents/agentRuntimeService.js';
import { actionBusService } from './actionBusService.js';
import { PlatformActionRepository } from '../../repositories/platformActionRepository.js';
import { pool } from '../../db/pool.js';
import { MaintenanceCreateWorkOrderExecutor, MAINTENANCE_CREATE_WORK_ORDER_ACTION_TYPE } from '../property/maintenanceWorkOrderExecutor.js';

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

  actionBusService.setRepository(new PlatformActionRepository(pool));
  if (!actionBusService.listExecutors().includes(MAINTENANCE_CREATE_WORK_ORDER_ACTION_TYPE)) {
    actionBusService.register(new MaintenanceCreateWorkOrderExecutor());
  }

  // Property maintenance triage is a real, sellable product capability, not
  // an experimental feature - on by default. PROPERTY_OPERATIONS_ENABLED=false
  // remains available as an explicit kill switch (e.g. a Gemini/AiGateway
  // incident affecting triage quality) without touching this file.
  if (process.env.PROPERTY_OPERATIONS_ENABLED !== 'false') {
    const existing = skillRegistry.get(propertyMaintenanceTriageSkill.id);
    if (existing && !existing.enabled) skillRegistry.enable(propertyMaintenanceTriageSkill.id);
  }

  initialized = true;
}
