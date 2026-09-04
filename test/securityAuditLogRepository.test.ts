import { describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { SecurityAuditLogRepository } from '../src/repositories/securityAuditLogRepository.js';
import { createTestBusiness } from './helpers.js';

/**
 * Section 116 (audit logging): billingRoutes.ts's developer-only plan/
 * entitlement-config routes and productAccountRoutes.ts's assign-vertical
 * route previously mutated real platform state with no audit trail at
 * all. Migration 974 made security_audit_logs.business_id nullable so a
 * genuinely platform-wide event (a plan applies across every subscribed
 * business, so there's no single business_id to attach it to) can be
 * recorded without inventing a fake owner - same precedent as
 * platform_skills.business_id (a global, non-tenant skill).
 */
describe('SecurityAuditLogRepository - platform-wide events (real Postgres, migration 974)', () => {
  it('records a genuinely platform-wide event with a null businessId', async () => {
    const repo = new SecurityAuditLogRepository(pool);
    const record = await repo.record({
      businessId: null,
      eventType: 'plan_updated',
      rawMetadata: { planId: 'plan-1', changedBy: 'user-1', changes: { priceMonthlyCents: 5000 } },
    });
    expect(record.businessId).toBeNull();
    expect(record.eventType).toBe('plan_updated');
  });

  it('accepts the new plan_entitlement_updated and vertical_assigned event types', async () => {
    const repo = new SecurityAuditLogRepository(pool);
    const businessId = await createTestBusiness();
    await expect(repo.record({ businessId: null, eventType: 'plan_entitlement_updated', rawMetadata: {} })).resolves.toBeTruthy();
    await expect(repo.record({ businessId, eventType: 'vertical_assigned', rawMetadata: { productKey: 'retail' } })).resolves.toBeTruthy();
  });

  it('listPlatformEvents returns only the null-businessId rows, newest first', async () => {
    const repo = new SecurityAuditLogRepository(pool);
    const businessId = await createTestBusiness();
    await repo.record({ businessId, eventType: 'vertical_assigned', rawMetadata: {} });
    const first = await repo.record({ businessId: null, eventType: 'plan_updated', rawMetadata: { order: 1 } });
    await new Promise((r) => setTimeout(r, 5));
    const second = await repo.record({ businessId: null, eventType: 'plan_updated', rawMetadata: { order: 2 } });

    const events = await repo.listPlatformEvents();
    const ids = events.map((e) => e.id);
    expect(ids).toContain(first.id);
    expect(ids).toContain(second.id);
    expect(ids.indexOf(second.id)).toBeLessThan(ids.indexOf(first.id));
    expect(events.every((e) => e.businessId === null)).toBe(true);
  });

  it('a business-scoped listRecent never returns a platform-wide event - real tenant isolation, not just a filter one caller happens to apply', async () => {
    const repo = new SecurityAuditLogRepository(pool);
    const businessId = await createTestBusiness();
    await repo.record({ businessId, eventType: 'vertical_assigned', rawMetadata: {} });
    await repo.record({ businessId: null, eventType: 'plan_updated', rawMetadata: {} });

    const events = await repo.listRecent(businessId);
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe('vertical_assigned');
  });
});
