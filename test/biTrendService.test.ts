import { describe, expect, it } from 'vitest';
import { queryAsTenant } from '../src/db/pool.js';
import { BiObservationRepository } from '../src/repositories/biObservationRepository.js';
import { computeProductTopicTrends, MIN_SAMPLE_SIZE, EARLY_SIGNAL_THRESHOLD } from '../src/services/businessIntelligence/biTrendService.js';
import { createTestBusiness, resetDatabase } from './helpers.js';

const CURRENT_START = '2024-01-02T00:00:00.000Z';
const CURRENT_END = '2024-01-03T00:00:00.000Z';
const CURRENT_MID = '2024-01-02T12:00:00.000Z';
// computeProductTopicTrends derives the previous period automatically as
// the immediately preceding period of equal length - real Jan 1 here.
const PREVIOUS_MID = '2024-01-01T12:00:00.000Z';

async function seedObservations(repo: BiObservationRepository, businessId: string, periodMid: string, count: number, overrides: { product?: string; topic?: string } = {}) {
  for (let i = 0; i < count; i++) {
    await repo.create({
      businessId,
      sourceType: 'chat',
      periodStart: periodMid,
      periodEnd: periodMid,
      product: overrides.product ?? 'Widget X',
      topic: overrides.topic ?? 'Battery',
      sentiment: 'positive',
      conversationCount: 1,
    });
  }
}

describe('biTrendService (real Postgres) - deterministic period-over-period trend math, no LLM', () => {
  it('sample-size boundary: below MIN_SAMPLE_SIZE is insufficient_data, at MIN_SAMPLE_SIZE is early_signal', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const repo = new BiObservationRepository(queryAsTenant(businessId));

    await seedObservations(repo, businessId, CURRENT_MID, MIN_SAMPLE_SIZE - 1);
    let trends = await computeProductTopicTrends(businessId, CURRENT_START, CURRENT_END);
    expect(trends.find((t) => t.product === 'Widget X')?.confidence).toBe('insufficient_data');

    await seedObservations(repo, businessId, CURRENT_MID, 1); // now exactly MIN_SAMPLE_SIZE
    trends = await computeProductTopicTrends(businessId, CURRENT_START, CURRENT_END);
    const trend = trends.find((t) => t.product === 'Widget X');
    expect(trend?.currentObservationCount).toBe(MIN_SAMPLE_SIZE);
    expect(trend?.confidence).toBe('early_signal');
  });

  it('confidence escalates to moderate then high past EARLY_SIGNAL_THRESHOLD', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const repo = new BiObservationRepository(queryAsTenant(businessId));

    await seedObservations(repo, businessId, CURRENT_MID, EARLY_SIGNAL_THRESHOLD);
    let trends = await computeProductTopicTrends(businessId, CURRENT_START, CURRENT_END);
    expect(trends.find((t) => t.product === 'Widget X')?.confidence).toBe('moderate');

    await seedObservations(repo, businessId, CURRENT_MID, EARLY_SIGNAL_THRESHOLD * 2); // total = 3x threshold
    trends = await computeProductTopicTrends(businessId, CURRENT_START, CURRENT_END);
    expect(trends.find((t) => t.product === 'Widget X')?.confidence).toBe('high');
  });

  it('direction: no prior-period observations for a topic that has current ones is "emerging"', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const repo = new BiObservationRepository(queryAsTenant(businessId));
    await seedObservations(repo, businessId, CURRENT_MID, 15);

    const trends = await computeProductTopicTrends(businessId, CURRENT_START, CURRENT_END);
    const trend = trends.find((t) => t.product === 'Widget X');
    expect(trend?.previousObservationCount).toBe(0);
    expect(trend?.direction).toBe('emerging');
    expect(trend?.changePct).toBeNull();
  });

  it('direction: a real, computed increase past the 10% stability band is "increasing", with correct changePct', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const repo = new BiObservationRepository(queryAsTenant(businessId));
    await seedObservations(repo, businessId, PREVIOUS_MID, 20);
    await seedObservations(repo, businessId, CURRENT_MID, 30);

    const trends = await computeProductTopicTrends(businessId, CURRENT_START, CURRENT_END);
    const trend = trends.find((t) => t.product === 'Widget X');
    expect(trend?.previousObservationCount).toBe(20);
    expect(trend?.currentObservationCount).toBe(30);
    expect(trend?.direction).toBe('increasing');
    expect(trend?.changePct).toBe(50); // (30-20)/20 * 100
  });

  it('direction: a real, computed decrease past the 10% stability band is "decreasing"', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const repo = new BiObservationRepository(queryAsTenant(businessId));
    await seedObservations(repo, businessId, PREVIOUS_MID, 30);
    await seedObservations(repo, businessId, CURRENT_MID, 15);

    const trends = await computeProductTopicTrends(businessId, CURRENT_START, CURRENT_END);
    const trend = trends.find((t) => t.product === 'Widget X');
    expect(trend?.direction).toBe('decreasing');
    expect(trend?.changePct).toBe(-50);
  });

  it('direction: within the 10% band either way is "stable", never manufactured movement', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const repo = new BiObservationRepository(queryAsTenant(businessId));
    await seedObservations(repo, businessId, PREVIOUS_MID, 20);
    await seedObservations(repo, businessId, CURRENT_MID, 21); // +5%, inside the band

    const trends = await computeProductTopicTrends(businessId, CURRENT_START, CURRENT_END);
    const trend = trends.find((t) => t.product === 'Widget X');
    expect(trend?.direction).toBe('stable');
  });

  it('different product/topic/sentiment groups are never conflated', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const repo = new BiObservationRepository(queryAsTenant(businessId));
    await seedObservations(repo, businessId, CURRENT_MID, 15, { product: 'Widget X', topic: 'Battery' });
    await seedObservations(repo, businessId, CURRENT_MID, 15, { product: 'Widget Y', topic: 'Price' });

    const trends = await computeProductTopicTrends(businessId, CURRENT_START, CURRENT_END);
    expect(trends).toHaveLength(2);
    expect(trends.map((t) => t.product).sort()).toEqual(['Widget X', 'Widget Y']);
  });

  it('is deterministic - the same underlying data produces the exact same result on a second call', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const repo = new BiObservationRepository(queryAsTenant(businessId));
    await seedObservations(repo, businessId, PREVIOUS_MID, 18);
    await seedObservations(repo, businessId, CURRENT_MID, 25);

    const first = await computeProductTopicTrends(businessId, CURRENT_START, CURRENT_END);
    const second = await computeProductTopicTrends(businessId, CURRENT_START, CURRENT_END);
    expect(second).toEqual(first);
  });
});
