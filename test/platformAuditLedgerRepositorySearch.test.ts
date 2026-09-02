import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { PlatformAuditLedgerRepository } from '../src/repositories/platformAuditLedgerRepository.js';
import type { AuditEvent } from '../src/domain/platform/contracts.js';
import { createTestBusiness, resetDatabase } from './helpers.js';

const repo = new PlatformAuditLedgerRepository(pool);

function fakeEvent(overrides: Partial<AuditEvent> & { tenantId: string }): AuditEvent {
  return {
    id: randomUUID(),
    eventType: 'action.executed',
    actor: { kind: 'AGENT', id: 'agent-1' },
    correlationId: randomUUID(),
    payload: {},
    payloadHash: randomUUID(),
    occurredAt: new Date().toISOString(),
    ...overrides,
  };
}

/**
 * Real regression coverage: PlatformAuditLedgerRepository.append() is real
 * and live (actionBusService.ts, propertyMaintenanceOrchestrator.ts write
 * through it on every real action/approval), but until search() was added,
 * nothing in this codebase ever read that data back - listByTenant() had
 * no limit/filter and was itself never called either. This is the "did the
 * Activity Log actually work" test.
 */
describe('PlatformAuditLedgerRepository.search (real Postgres, real hash-chained append)', () => {
  let businessId: string;

  beforeEach(async () => {
    await resetDatabase();
    businessId = await createTestBusiness();
  });

  it('returns nothing for a business with no real audit history', async () => {
    const result = await repo.search(businessId);
    expect(result).toEqual({ events: [], nextCursor: null });
  });

  it('returns real events most-recent-first', async () => {
    await repo.append(businessId, fakeEvent({ tenantId: businessId, eventType: 'action.proposed' }));
    await repo.append(businessId, fakeEvent({ tenantId: businessId, eventType: 'action.approved' }));
    await repo.append(businessId, fakeEvent({ tenantId: businessId, eventType: 'action.executed' }));

    const result = await repo.search(businessId);
    expect(result.events.map((e) => e.eventType)).toEqual(['action.executed', 'action.approved', 'action.proposed']);
    expect(result.nextCursor).toBeNull(); // fewer than the page size - no more pages
  });

  it('filters by real eventType', async () => {
    await repo.append(businessId, fakeEvent({ tenantId: businessId, eventType: 'action.proposed' }));
    await repo.append(businessId, fakeEvent({ tenantId: businessId, eventType: 'action.approved' }));

    const result = await repo.search(businessId, { eventType: 'action.approved' });
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.eventType).toBe('action.approved');
  });

  it('filters by real actorKind', async () => {
    await repo.append(businessId, fakeEvent({ tenantId: businessId, actor: { kind: 'AGENT', id: 'agent-1' } }));
    await repo.append(businessId, fakeEvent({ tenantId: businessId, actor: { kind: 'USER', id: 'user-1' } }));

    const result = await repo.search(businessId, { actorKind: 'USER' });
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.actor.kind).toBe('USER');
  });

  it('paginates via a real sequence cursor, never skipping or repeating a real event', async () => {
    for (let i = 0; i < 5; i += 1) {
      await repo.append(businessId, fakeEvent({ tenantId: businessId, eventType: `event.${i}` }));
    }

    const firstPage = await repo.search(businessId, { limit: 2 });
    expect(firstPage.events).toHaveLength(2);
    expect(firstPage.events.map((e) => e.eventType)).toEqual(['event.4', 'event.3']);
    expect(firstPage.nextCursor).not.toBeNull();

    const secondPage = await repo.search(businessId, { limit: 2, beforeSequence: firstPage.nextCursor! });
    expect(secondPage.events.map((e) => e.eventType)).toEqual(['event.2', 'event.1']);

    const thirdPage = await repo.search(businessId, { limit: 2, beforeSequence: secondPage.nextCursor! });
    expect(thirdPage.events.map((e) => e.eventType)).toEqual(['event.0']);
    expect(thirdPage.nextCursor).toBeNull(); // real end of history
  });

  it('never leaks another business\'s audit events', async () => {
    const otherBusinessId = await createTestBusiness('Other Business');
    await repo.append(otherBusinessId, fakeEvent({ tenantId: otherBusinessId, eventType: 'other.event' }));
    await repo.append(businessId, fakeEvent({ tenantId: businessId, eventType: 'this.event' }));

    const result = await repo.search(businessId);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.eventType).toBe('this.event');
  });
});
