import { randomUUID } from 'node:crypto';
import { pool } from '../../db/pool.js';
import { PropertyOperationsRepository } from '../../repositories/propertyOperationsRepository.js';
import type { ActionExecutor, ActionExecutionContext } from '../platform/actionBusService.js';
import type { ActionRequest } from '../../domain/platform/contracts.js';

export const MAINTENANCE_CREATE_WORK_ORDER_ACTION_TYPE = 'maintenance.create_work_order';

/**
 * The real production side effect behind a "create a work order" action -
 * moved here verbatim from platformApprovalRouter.ts's own inline
 * post-approval handler (create incident, prefer an emergency-available
 * vendor for the category, create the work order) so it can be dispatched
 * through ActionBusService instead of hand-rolled in the route. Behavior
 * is unchanged: same fields, same vendor-preference order, same defaults.
 */
export class MaintenanceCreateWorkOrderExecutor implements ActionExecutor {
  readonly actionType = MAINTENANCE_CREATE_WORK_ORDER_ACTION_TYPE;

  constructor(private readonly propertyRepo = new PropertyOperationsRepository(pool)) {}

  async execute(
    action: ActionRequest,
    _context: ActionExecutionContext,
  ): Promise<{ status: 'SUCCEEDED' | 'FAILED'; result?: unknown; error?: string | undefined }> {
    const payload = action.payload;
    const propertyId = payload.propertyId;
    if (typeof propertyId !== 'string' || !propertyId) {
      return { status: 'FAILED', error: 'action payload is missing a valid propertyId' };
    }

    const summary = typeof payload.summary === 'string' ? payload.summary : typeof payload.messageText === 'string' ? payload.messageText : 'Maintenance issue';
    const category = String(payload.category ?? 'OTHER');
    const urgency = String(payload.urgency ?? 'ROUTINE');

    try {
      const incident = await this.propertyRepo.createIncident({
        id: randomUUID(),
        businessId: action.tenantId,
        propertyId,
        sourceChannel: 'WHATSAPP',
        title: `${category} — ${urgency}`,
        description: typeof payload.messageText === 'string' ? payload.messageText : summary,
        category,
        severity: urgency,
        status: 'OPEN',
        confidence: typeof payload.confidence === 'number' ? payload.confidence : undefined,
        aiSummary: summary,
      });

      // Prefer a vendor that handles this category and is emergency-available.
      const vendors = await this.propertyRepo.listVendors(action.tenantId, category.toLowerCase());
      const vendor = vendors.find((v) => v.emergencyAvailable) ?? vendors[0];
      const workOrder = await this.propertyRepo.createWorkOrder({
        id: randomUUID(),
        businessId: action.tenantId,
        incidentId: incident.id,
        vendorId: vendor?.id,
        status: 'PENDING_APPROVAL',
        priority: urgency,
        description: summary,
      });

      return { status: 'SUCCEEDED', result: { incidentId: incident.id, workOrderId: workOrder.id, vendorId: vendor?.id } };
    } catch (error) {
      return { status: 'FAILED', error: error instanceof Error ? error.message : String(error) };
    }
  }
}
