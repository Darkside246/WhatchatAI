import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { MaintenanceCreateWorkOrderExecutor, MAINTENANCE_CREATE_WORK_ORDER_ACTION_TYPE } from '../src/services/property/maintenanceWorkOrderExecutor.js';
import { PropertyOperationsRepository } from '../src/repositories/propertyOperationsRepository.js';
import { createTestBusiness } from './helpers.js';
import type { ActionRequest } from '../src/domain/platform/contracts.js';

async function createTestProperty(businessId: string, name = 'Test Villa'): Promise<string> {
  const { rows } = await pool.query<{ id: string }>('INSERT INTO property_properties (business_id, name) VALUES ($1, $2) RETURNING id', [businessId, name]);
  return rows[0]!.id;
}

function fakeAction(businessId: string, overrides: Partial<ActionRequest['payload']> = {}): ActionRequest {
  return {
    id: 'action-1',
    tenantId: businessId,
    type: MAINTENANCE_CREATE_WORK_ORDER_ACTION_TYPE,
    payload: { propertyId: '', category: 'PLUMBING', urgency: 'URGENT', summary: 'Leaking pipe under the sink', messageText: 'There is a leak under my sink', confidence: 0.9, ...overrides },
    requestedBy: { kind: 'AGENT', id: 'property-maintenance-triage' },
    riskLevel: 'MEDIUM',
    approval: { required: true, status: 'APPROVED' },
    status: 'READY',
    idempotencyKey: 'idem-1',
    correlationId: 'corr-1',
    createdAt: new Date().toISOString(),
  };
}

describe('MaintenanceCreateWorkOrderExecutor (real Postgres - moved verbatim from platformApprovalRouter.ts)', () => {
  let businessId: string;
  let propertyId: string;
  const executor = new MaintenanceCreateWorkOrderExecutor();
  const propertyRepo = new PropertyOperationsRepository(pool);

  beforeEach(async () => {
    businessId = await createTestBusiness();
    propertyId = await createTestProperty(businessId);
  });

  it('creates an incident and a work order with the right fields', async () => {
    const action = fakeAction(businessId, { propertyId });
    const result = await executor.execute(action, { tenantId: businessId, actorId: 'user-1' });

    expect(result.status).toBe('SUCCEEDED');
    const { incidentId, workOrderId } = result.result as { incidentId: string; workOrderId: string };

    const incidents = await propertyRepo.listIncidents(businessId, propertyId);
    expect(incidents).toHaveLength(1);
    expect(incidents[0]!.id).toBe(incidentId);
    expect(incidents[0]!.category).toBe('PLUMBING');
    expect(incidents[0]!.severity).toBe('URGENT');
    expect(incidents[0]!.description).toBe('There is a leak under my sink');
    expect(incidents[0]!.aiSummary).toBe('Leaking pipe under the sink');
    // property_incidents.confidence is a NUMERIC column - node-postgres
    // returns it as a string by default (no custom type parser configured
    // for this column, unlike TIMESTAMPTZ in db/pool.ts), so IncidentRecord's
    // `confidence: number` type does not match its actual runtime shape here.
    expect(Number(incidents[0]!.confidence)).toBe(0.9);

    const workOrders = await propertyRepo.listWorkOrders(businessId, incidentId);
    expect(workOrders).toHaveLength(1);
    expect(workOrders[0]!.id).toBe(workOrderId);
    expect(workOrders[0]!.priority).toBe('URGENT');
    expect(workOrders[0]!.status).toBe('PENDING_APPROVAL');
    expect(workOrders[0]!.description).toBe('Leaking pipe under the sink');
  });

  it('prefers an emergency-available vendor over a non-emergency one for the same category', async () => {
    const vendorA = randomUUID();
    const vendorB = randomUUID();
    await propertyRepo.createVendor({ id: vendorA, businessId, name: 'Regular Plumber', serviceCategories: ['plumbing'], emergencyAvailable: false });
    await propertyRepo.createVendor({ id: vendorB, businessId, name: 'Emergency Plumber', serviceCategories: ['plumbing'], emergencyAvailable: true });

    const action = fakeAction(businessId, { propertyId });
    const result = await executor.execute(action, { tenantId: businessId, actorId: 'user-1' });
    const { workOrderId } = result.result as { workOrderId: string };
    const workOrders = await propertyRepo.listWorkOrders(businessId);
    const workOrder = workOrders.find((w) => w.id === workOrderId);
    expect(workOrder?.vendorId).toBe(vendorB);
  });

  it('falls back to the first available vendor for the category when none is emergency-available', async () => {
    const vendorC = randomUUID();
    await propertyRepo.createVendor({ id: vendorC, businessId, name: 'Only Plumber', serviceCategories: ['plumbing'], emergencyAvailable: false });

    const action = fakeAction(businessId, { propertyId });
    const result = await executor.execute(action, { tenantId: businessId, actorId: 'user-1' });
    const { workOrderId } = result.result as { workOrderId: string };
    const workOrder = (await propertyRepo.listWorkOrders(businessId)).find((w) => w.id === workOrderId);
    expect(workOrder?.vendorId).toBe(vendorC);
  });

  it('leaves vendorId unset when no vendor exists for the category - never fabricates one', async () => {
    const action = fakeAction(businessId, { propertyId, category: 'ELECTRICAL' });
    const result = await executor.execute(action, { tenantId: businessId, actorId: 'user-1' });
    const { workOrderId } = result.result as { workOrderId: string };
    const workOrder = (await propertyRepo.listWorkOrders(businessId)).find((w) => w.id === workOrderId);
    expect(workOrder?.vendorId).toBeNull();
  });

  it('fails cleanly (no partial incident) when the payload has no valid propertyId', async () => {
    const action = fakeAction(businessId, { propertyId: undefined as unknown as string });
    const result = await executor.execute(action, { tenantId: businessId, actorId: 'user-1' });
    expect(result.status).toBe('FAILED');
    expect(result.error).toContain('propertyId');
    const incidents = await propertyRepo.listIncidents(businessId);
    expect(incidents).toHaveLength(0);
  });

  it('fails cleanly rather than throwing when the property does not actually exist for this business (FK violation)', async () => {
    const action = fakeAction(businessId, { propertyId: '00000000-0000-0000-0000-000000000099' });
    const result = await executor.execute(action, { tenantId: businessId, actorId: 'user-1' });
    expect(result.status).toBe('FAILED');
    expect(result.error).toBeTruthy();
  });
});
