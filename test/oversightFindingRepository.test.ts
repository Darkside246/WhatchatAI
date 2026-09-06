import { describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { OversightFindingRepository, type CreateOversightFindingInput } from '../src/repositories/oversightFindingRepository.js';
import { createTestBusiness, createTestUser, resetDatabase } from './helpers.js';

function baseInput(overrides: Partial<CreateOversightFindingInput> = {}): CreateOversightFindingInput {
  return {
    category: 'application_health',
    findingType: 'queue_backlog_high',
    title: 'Queue "incomingMessages" is unhealthy',
    severity: 'medium',
    dedupKey: 'application_health:queue_backlog:incomingMessages',
    ...overrides,
  };
}

describe('OversightFindingRepository (real Postgres, AURA AI Oversight & Reliability Agent)', () => {
  it('creates a finding and returns it via listOpenAcrossPlatform, with a real business-name join when business-scoped', async () => {
    const repo = new OversightFindingRepository(pool);
    const businessId = await createTestBusiness('Acme Corp');
    const created = await repo.create(baseInput({ businessId, dedupKey: 'capacity:entitlement_near_limit' }));
    expect(created.status).toBe('detected');
    expect(created.occurrenceCount).toBe(1);

    const open = await repo.listOpenAcrossPlatform();
    const found = open.find((f) => f.id === created.id);
    expect(found?.businessName).toBe('Acme Corp');
  });

  it('findOpenByDedupKey only matches a non-terminal finding, and recordReoccurrence bumps occurrence_count/last_detected_at rather than creating a new row', async () => {
    const repo = new OversightFindingRepository(pool);
    const created = await repo.create(baseInput({ dedupKey: 'application_health:database_down' }));
    expect(await repo.findOpenByDedupKey('application_health:database_down')).not.toBeNull();

    const bumped = await repo.recordReoccurrence(created.id);
    expect(bumped.occurrenceCount).toBe(2);
    expect(new Date(bumped.lastDetectedAt).getTime()).toBeGreaterThanOrEqual(new Date(created.firstDetectedAt).getTime());

    const events = await repo.listEventsForFinding(created.id);
    expect(events.map((e) => e.eventType)).toEqual(['raised', 'reoccurred']);
  });

  it('changeStatus appends a real status_changed event and is final once resolved/rejected - never reopens or overwrites', async () => {
    const repo = new OversightFindingRepository(pool);
    const businessId = await createTestBusiness();
    const userId = await createTestUser(businessId);
    const created = await repo.create(baseInput({ dedupKey: 'policy:config_left_on:maintenance_mode' }));

    const investigating = await repo.changeStatus(created.id, 'investigating', userId, 'Looking into it');
    expect(investigating?.status).toBe('investigating');

    const resolved = await repo.changeStatus(created.id, 'resolved', userId);
    expect(resolved?.status).toBe('resolved');

    // Once terminal, further transitions are rejected (null), never silently reopened.
    expect(await repo.changeStatus(created.id, 'investigating', userId)).toBeNull();

    const events = await repo.listEventsForFinding(created.id);
    expect(events.map((e) => e.eventType)).toEqual(['raised', 'status_changed', 'status_changed']);
    expect(events[1]?.toStatus).toBe('investigating');
    expect(events[1]?.notes).toBe('Looking into it');
    expect(events[2]?.toStatus).toBe('resolved');
  });

  it('listOpenAcrossPlatform excludes resolved/rejected findings, and supports category/severity filters', async () => {
    const repo = new OversightFindingRepository(pool);
    const businessId = await createTestBusiness();
    const userId = await createTestUser(businessId);
    const open = await repo.create(baseInput({ dedupKey: 'security:auth_abuse_spike_a', category: 'security', severity: 'high' }));
    const resolved = await repo.create(baseInput({ dedupKey: 'security:auth_abuse_spike_b', category: 'security', severity: 'high' }));
    await repo.changeStatus(resolved.id, 'resolved', userId);
    const otherCategory = await repo.create(baseInput({ dedupKey: 'capacity:queue_backlog_trend', category: 'capacity', severity: 'low' }));

    const all = await repo.listOpenAcrossPlatform();
    expect(all.find((f) => f.id === open.id)).toBeDefined();
    expect(all.find((f) => f.id === resolved.id)).toBeUndefined();
    expect(all.find((f) => f.id === otherCategory.id)).toBeDefined();

    const securityOnly = await repo.listOpenAcrossPlatform({ category: 'security' });
    expect(securityOnly.map((f) => f.id)).toEqual([open.id]);

    const highOnly = await repo.listOpenAcrossPlatform({ severity: 'high' });
    expect(highOnly.map((f) => f.id)).toEqual([open.id]);
  });

  it('recordSample/listRecentSamples round-trips real values in chronological order, scoped to the given metric key', async () => {
    // A global (business-scoped-null) metric, unlike every other test in
    // this file - needs a real reset since it has no per-business
    // narrowing to naturally isolate it from another test file's own
    // samples recorded moments earlier in the same shared test run.
    await resetDatabase();
    const repo = new OversightFindingRepository(pool);
    await repo.recordSample('queue_waiting_total', 10);
    await repo.recordSample('queue_waiting_total', 25);
    await repo.recordSample('whatsapp_connected_tenants', 3);

    const sinceIso = new Date(Date.now() - 60_000).toISOString();
    const samples = await repo.listRecentSamples('queue_waiting_total', sinceIso);
    expect(samples.map((s) => s.value)).toEqual([10, 25]);
  });
});
