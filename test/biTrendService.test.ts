import { describe, expect, it } from 'vitest';
import { queryAsTenant } from '../src/db/pool.js';
import { BiObservationRepository } from '../src/repositories/biObservationRepository.js';
import { computeProductTopicTrends, classifyRisk, MIN_SAMPLE_SIZE, EARLY_SIGNAL_THRESHOLD, MAX_CONSECUTIVE_PERIOD_LOOKBACK } from '../src/services/businessIntelligence/biTrendService.js';
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

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
/** i=0 is CURRENT_MID, i=1 is PREVIOUS_MID, i=2+ walks further back one equal-length period at a time. */
function midForPeriodsBack(i: number): string {
  return new Date(new Date(CURRENT_MID).getTime() - i * ONE_DAY_MS).toISOString();
}

describe('biTrendService - consecutivePeriods (real Postgres, multi-period streak)', () => {
  it('counts a real, unbroken streak across consecutive periods', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const repo = new BiObservationRepository(queryAsTenant(businessId));
    await seedObservations(repo, businessId, midForPeriodsBack(0), 12);
    await seedObservations(repo, businessId, midForPeriodsBack(1), 12);
    await seedObservations(repo, businessId, midForPeriodsBack(2), 12);

    const trends = await computeProductTopicTrends(businessId, CURRENT_START, CURRENT_END);
    expect(trends.find((t) => t.product === 'Widget X')?.consecutivePeriods).toBe(3);
  });

  it('a genuine gap stops the count immediately - never overcounts past it', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const repo = new BiObservationRepository(queryAsTenant(businessId));
    await seedObservations(repo, businessId, midForPeriodsBack(0), 12);
    // Period 1 (immediately preceding) deliberately skipped.
    await seedObservations(repo, businessId, midForPeriodsBack(2), 12);

    const trends = await computeProductTopicTrends(businessId, CURRENT_START, CURRENT_END);
    expect(trends.find((t) => t.product === 'Widget X')?.consecutivePeriods).toBe(1);
  });

  it('never counts past the documented MAX_CONSECUTIVE_PERIOD_LOOKBACK cap', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const repo = new BiObservationRepository(queryAsTenant(businessId));
    for (let i = 0; i <= MAX_CONSECUTIVE_PERIOD_LOOKBACK; i++) {
      await seedObservations(repo, businessId, midForPeriodsBack(i), 12);
    }

    const trends = await computeProductTopicTrends(businessId, CURRENT_START, CURRENT_END);
    expect(trends.find((t) => t.product === 'Widget X')?.consecutivePeriods).toBe(1 + MAX_CONSECUTIVE_PERIOD_LOOKBACK);
  });
});

describe('classifyRisk - real risk-tier boundaries (pure, deterministic, no LLM)', () => {
  it('is always null when sentiment is not negative, regardless of direction/confidence', () => {
    for (const sentiment of ['positive', 'neutral', 'mixed', 'unclear', null]) {
      expect(classifyRisk({ sentiment, direction: 'increasing', confidence: 'high' })).toBeNull();
    }
  });

  it('is high: negative + worsening (increasing/emerging) + strong confidence (moderate/high)', () => {
    expect(classifyRisk({ sentiment: 'negative', direction: 'increasing', confidence: 'moderate' })).toBe('high');
    expect(classifyRisk({ sentiment: 'negative', direction: 'increasing', confidence: 'high' })).toBe('high');
    expect(classifyRisk({ sentiment: 'negative', direction: 'emerging', confidence: 'moderate' })).toBe('high');
    expect(classifyRisk({ sentiment: 'negative', direction: 'emerging', confidence: 'high' })).toBe('high');
  });

  it('is medium: negative + worsening + early_signal, OR negative + stable/anomalous + strong confidence', () => {
    expect(classifyRisk({ sentiment: 'negative', direction: 'increasing', confidence: 'early_signal' })).toBe('medium');
    expect(classifyRisk({ sentiment: 'negative', direction: 'emerging', confidence: 'early_signal' })).toBe('medium');
    expect(classifyRisk({ sentiment: 'negative', direction: 'stable', confidence: 'moderate' })).toBe('medium');
    expect(classifyRisk({ sentiment: 'negative', direction: 'anomalous', confidence: 'high' })).toBe('medium');
  });

  it('is low: every other negative combination', () => {
    expect(classifyRisk({ sentiment: 'negative', direction: 'decreasing', confidence: 'high' })).toBe('low');
    expect(classifyRisk({ sentiment: 'negative', direction: 'declining', confidence: 'moderate' })).toBe('low');
    expect(classifyRisk({ sentiment: 'negative', direction: 'stable', confidence: 'early_signal' })).toBe('low');
    expect(classifyRisk({ sentiment: 'negative', direction: 'anomalous', confidence: 'early_signal' })).toBe('low');
  });
});
