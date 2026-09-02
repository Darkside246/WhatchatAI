import { checkDatabaseHealth } from '../db/pool.js';
import { checkRedisHealth } from '../redis/client.js';
import { checkQueueHealth } from '../queue/queueHealth.js';
import { getHealthSummary as getGooseHealthSummary } from './gooseService.js';

/**
 * Aggregates the real /api/health/* probes (database, redis, BullMQ
 * queues, Goose fallback) into one developer-facing view. Extracted out
 * of the route handler specifically so it's directly testable - this
 * codebase has no HTTP route test harness (see controlPlaneStats.test.ts's
 * own doc comment for why that lesson exists).
 */
export async function getSystemHealth() {
  const [database, redis, queues, goose] = await Promise.all([
    checkDatabaseHealth(),
    checkRedisHealth(),
    checkQueueHealth(),
    getGooseHealthSummary(),
  ]);
  const ai = { configured: Boolean(process.env.GEMINI_API_KEY), model: process.env.GEMINI_MODEL ?? 'gemini-3.5-flash-lite' };
  return { database, redis, queues, goose, ai };
}
