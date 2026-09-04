import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { PropertyOperationsRepository } from '../src/repositories/propertyOperationsRepository.js';
import { createTestBusiness } from './helpers.js';

async function createTestProperty(businessId: string, name = 'Test Villa'): Promise<string> {
  const { rows } = await pool.query<{ id: string }>('INSERT INTO property_properties (business_id, name) VALUES ($1, $2) RETURNING id', [businessId, name]);
  return rows[0]!.id;
}

/**
 * Section 60-62: before this, property_incidents/property_work_orders had
 * a real create() and nothing else - every incident stayed OPEN and every
 * work order stayed PENDING_APPROVAL forever, regardless of what actually
 * happened. These are the first real lifecycle mutations either table has
 * ever had.
 */
describe('PropertyOperationsRepository - incident/work order lifecycle (real Postgres)', () => {
  let businessId: string;
  let propertyId: string;
  let repo: PropertyOperationsRepository;

  beforeEach(async () => {
    businessId = await createTestBusiness();
    propertyId = await createTestProperty(businessId);
    repo = new PropertyOperationsRepository(pool);
  });

  describe('updateIncidentStatus', () => {
    it('transitions status and stamps resolved_at exactly once for RESOLVED', async () => {
      const incident = await repo.createIncident({
        id: randomUUID(), businessId, propertyId, sourceChannel: 'WEB',
        title: 'Broken AC', category: 'HVAC',
      });
      expect(incident.status).toBe('OPEN');
      expect(incident.resolvedAt).toBeNull();

      const resolved = await repo.updateIncidentStatus(businessId, incident.id, 'RESOLVED');
      expect(resolved?.status).toBe('RESOLVED');
      expect(resolved?.resolvedAt).not.toBeNull();

      const firstResolvedAt = resolved!.resolvedAt;
      await new Promise((r) => setTimeout(r, 5));
      const resolvedAgain = await repo.updateIncidentStatus(businessId, incident.id, 'RESOLVED');
      expect(resolvedAgain?.resolvedAt).toEqual(firstResolvedAt);
    });

    it('never stamps resolved_at for a non-terminal status', async () => {
      const incident = await repo.createIncident({ id: randomUUID(), businessId, propertyId, sourceChannel: 'WEB', title: 'Leak', category: 'PLUMBING' });
      const escalated = await repo.updateIncidentStatus(businessId, incident.id, 'ESCALATED');
      expect(escalated?.status).toBe('ESCALATED');
      expect(escalated?.resolvedAt).toBeNull();
    });

    it('can assign a vendor at the same time as a status change', async () => {
      const vendor = await repo.createVendor({ id: randomUUID(), businessId, name: 'Acme Plumbing' });
      const incident = await repo.createIncident({ id: randomUUID(), businessId, propertyId, sourceChannel: 'WEB', title: 'Leak', category: 'PLUMBING' });

      const updated = await repo.updateIncidentStatus(businessId, incident.id, 'ESCALATED', { vendorId: vendor.id });
      expect(updated?.vendorId).toBe(vendor.id);
    });

    it('returns null for a cross-tenant or nonexistent incident, never updating it', async () => {
      const incident = await repo.createIncident({ id: randomUUID(), businessId, propertyId, sourceChannel: 'WEB', title: 'Leak', category: 'PLUMBING' });
      const otherBusinessId = await createTestBusiness('Other Business');

      const result = await repo.updateIncidentStatus(otherBusinessId, incident.id, 'RESOLVED');
      expect(result).toBeNull();

      const untouched = await repo.listIncidents(businessId, propertyId);
      expect(untouched[0]?.status).toBe('OPEN');
    });
  });

  describe('updateWorkOrder', () => {
    async function createTestIncident() {
      return repo.createIncident({ id: randomUUID(), businessId, propertyId, sourceChannel: 'WEB', title: 'AC broken', category: 'HVAC' });
    }

    it('approves a work order and records the real approved cost, independent of a later completion', async () => {
      const incident = await createTestIncident();
      const workOrder = await repo.createWorkOrder({ id: randomUUID(), businessId, incidentId: incident.id, description: 'Replace compressor' });
      expect(workOrder.status).toBe('PENDING_APPROVAL');

      const approved = await repo.updateWorkOrder(businessId, workOrder.id, { status: 'APPROVED', approvedCostCents: 45000 });
      expect(approved?.status).toBe('APPROVED');
      // property_work_orders.approved_cost_cents is BIGINT - pg returns it
      // as a string by default (same as the existing confidence/NUMERIC
      // quirk documented in maintenanceWorkOrderExecutor.test.ts).
      expect(Number(approved?.approvedCostCents)).toBe(45000);
      expect(approved?.completedAt).toBeNull();

      const completed = await repo.updateWorkOrder(businessId, workOrder.id, { status: 'COMPLETED', completionNotes: 'Compressor replaced, unit tested.' });
      expect(completed?.status).toBe('COMPLETED');
      expect(completed?.completedAt).not.toBeNull();
      expect(completed?.completionNotes).toBe('Compressor replaced, unit tested.');
      // The approval from the earlier, separate call is never lost or reset by a later update.
      expect(Number(completed?.approvedCostCents)).toBe(45000);
    });

    it('leaves every field not passed untouched (undefined means no-op, not null-out)', async () => {
      const incident = await createTestIncident();
      const workOrder = await repo.createWorkOrder({ id: randomUUID(), businessId, incidentId: incident.id, description: 'Fix leak', estimatedCostCents: 10000 });

      const updated = await repo.updateWorkOrder(businessId, workOrder.id, { status: 'APPROVED' });
      expect(updated?.status).toBe('APPROVED');
      expect(Number(updated?.estimatedCostCents)).toBe(10000);
      expect(updated?.description).toBe('Fix leak');
    });

    it('Section 60-62 follow-up: sets a real scheduledFor value, and a later update can move it', async () => {
      const incident = await createTestIncident();
      const workOrder = await repo.createWorkOrder({ id: randomUUID(), businessId, incidentId: incident.id, description: 'Fix leak' });
      expect(workOrder.scheduledFor).toBeNull();

      const firstSlot = new Date('2026-02-01T14:00:00.000Z');
      const scheduled = await repo.updateWorkOrder(businessId, workOrder.id, { scheduledFor: firstSlot });
      expect(new Date(scheduled!.scheduledFor as unknown as string).toISOString()).toBe(firstSlot.toISOString());

      const secondSlot = new Date('2026-02-03T09:30:00.000Z');
      const rescheduled = await repo.updateWorkOrder(businessId, workOrder.id, { scheduledFor: secondSlot });
      expect(new Date(rescheduled!.scheduledFor as unknown as string).toISOString()).toBe(secondSlot.toISOString());
    });

    it('never stamps completed_at twice with different timestamps', async () => {
      const incident = await createTestIncident();
      const workOrder = await repo.createWorkOrder({ id: randomUUID(), businessId, incidentId: incident.id, description: 'Fix leak' });

      const first = await repo.updateWorkOrder(businessId, workOrder.id, { status: 'COMPLETED' });
      await new Promise((r) => setTimeout(r, 5));
      const second = await repo.updateWorkOrder(businessId, workOrder.id, { status: 'COMPLETED', completionNotes: 'updated notes' });
      expect(second?.completedAt).toEqual(first?.completedAt);
      expect(second?.completionNotes).toBe('updated notes');
    });

    it('returns null for a cross-tenant or nonexistent work order, never updating it', async () => {
      const incident = await createTestIncident();
      const workOrder = await repo.createWorkOrder({ id: randomUUID(), businessId, incidentId: incident.id, description: 'Fix leak' });
      const otherBusinessId = await createTestBusiness('Other Business');

      const result = await repo.updateWorkOrder(otherBusinessId, workOrder.id, { status: 'CANCELLED' });
      expect(result).toBeNull();

      const untouched = await repo.listWorkOrders(businessId, incident.id);
      expect(untouched[0]?.status).toBe('PENDING_APPROVAL');
    });
  });
});
