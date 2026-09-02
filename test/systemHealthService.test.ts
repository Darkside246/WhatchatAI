import { describe, expect, it } from 'vitest';
import { getSystemHealth } from '../src/services/systemHealthService.js';

/**
 * Real Postgres + real Redis + real BullMQ queues (no mocks) - proves the
 * aggregation actually composes the real health checks correctly, the
 * same lesson as controlPlaneStats.test.ts (this codebase has no HTTP
 * route test harness, so business logic gets extracted and tested
 * directly instead of through the Express layer).
 */
describe('getSystemHealth (real database/redis/queue/goose checks composed together)', () => {
  it('reports every real subsystem, with database and redis connected in this test environment', async () => {
    // Explicitly unset rather than assuming ambient state - gooseService.test.ts
    // sets/clears this same env var, and this file must not become order-dependent on it.
    const originalGooseUrl = process.env.GOOSE_SERVICE_URL;
    delete process.env.GOOSE_SERVICE_URL;
    let health: Awaited<ReturnType<typeof getSystemHealth>>;
    try {
      health = await getSystemHealth();
    } finally {
      if (originalGooseUrl !== undefined) process.env.GOOSE_SERVICE_URL = originalGooseUrl;
    }

    expect(health.database.available).toBe(true);
    expect(health.redis.available).toBe(true);

    expect(health.queues.queues.map((q) => q.name).sort()).toEqual([
      'document_parse',
      'email_send',
      'funnel_advance',
      'incoming_messages',
      'message_revocations',
      'outbound_messages',
      'realtime_events',
      'scheduled_statuses',
    ]);

    // No real GOOSE_SERVICE_URL is configured in this test environment -
    // must honestly report not_configured, never a fabricated "reachable".
    expect(health.goose.configured).toBe(false);
    expect(health.goose.reachable).toBe(false);

    expect(typeof health.ai.configured).toBe('boolean');
    expect(typeof health.ai.model).toBe('string');
  });
});
