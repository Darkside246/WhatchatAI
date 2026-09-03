import { propertyMaintenanceTriageSkill, skillRegistry } from './skillRegistry.js';
import { moduleRegistry, propertyOperationsModule } from './moduleRegistry.js';
import { initializeAiGateway } from '../ai/aiGatewayBootstrap.js';
import { initializeAgentRuntimes } from '../agents/agentRuntimeService.js';
import { actionBusService } from './actionBusService.js';
import { PlatformActionRepository } from '../../repositories/platformActionRepository.js';
import { pool } from '../../db/pool.js';
import { MaintenanceCreateWorkOrderExecutor, MAINTENANCE_CREATE_WORK_ORDER_ACTION_TYPE } from '../property/maintenanceWorkOrderExecutor.js';
import { GoogleMeetBookingExecutor, SCHEDULE_GOOGLE_MEET_ACTION_TYPE } from '../meeting/googleMeetBookingExecutor.js';
import { ZoomMeetBookingExecutor, SCHEDULE_ZOOM_MEETING_ACTION_TYPE } from '../meeting/zoomMeetBookingExecutor.js';

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
  // Only reachable for an agent at autonomy level 1-2 (see
  // aiReplyService.ts's createPendingApprovalAction) - an agent at level
  // 3+ still books immediately and never creates one of these actions.
  if (!actionBusService.listExecutors().includes(SCHEDULE_GOOGLE_MEET_ACTION_TYPE)) {
    actionBusService.register(new GoogleMeetBookingExecutor());
  }
  if (!actionBusService.listExecutors().includes(SCHEDULE_ZOOM_MEETING_ACTION_TYPE)) {
    actionBusService.register(new ZoomMeetBookingExecutor());
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
