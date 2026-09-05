import { describe, expect, it } from 'vitest';
import { pool, queryAsTenant } from '../src/db/pool.js';
import { BiSettingsRepository } from '../src/repositories/biSettingsRepository.js';
import { BiObservationRepository } from '../src/repositories/biObservationRepository.js';
import { BiInsightRepository } from '../src/repositories/biInsightRepository.js';
import { BiSecurityAlertRepository } from '../src/repositories/biSecurityAlertRepository.js';
import { CustomerReviewRepository } from '../src/repositories/customerReviewRepository.js';
import { createTestBusiness, resetDatabase } from './helpers.js';

describe('Business Intelligence Agent repositories (real Postgres) - RLS, fail-closed defaults, structured storage', () => {
  it('bi_settings: fail-closed by default (no row = not enabled), and setEnabled is idempotent-upsert', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const repo = new BiSettingsRepository(queryAsTenant(businessId));

    expect(await repo.get(businessId)).toBeNull();

    const enabled = await repo.setEnabled(businessId, true);
    expect(enabled.enabled).toBe(true);

    const disabled = await repo.setEnabled(businessId, false);
    expect(disabled.enabled).toBe(false);
  });

  it('bi_settings.listAllEnabled sees every enabled business, and only those (the scheduled sweep\'s own listing)', async () => {
    await resetDatabase();
    const businessA = await createTestBusiness('A');
    const businessB = await createTestBusiness('B');
    await new BiSettingsRepository(queryAsTenant(businessA)).setEnabled(businessA, true);
    await new BiSettingsRepository(queryAsTenant(businessB)).setEnabled(businessB, false);

    const repo = new BiSettingsRepository(pool);
    const enabled = await repo.listAllEnabled();
    expect(enabled.map((r) => r.businessId)).toEqual([businessA]);
  });

  it('bi_observations never stores raw text - only structured fields and counts round-trip', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const repo = new BiObservationRepository(queryAsTenant(businessId));
    const now = new Date().toISOString();

    const observation = await repo.create({
      businessId,
      sourceType: 'chat',
      periodStart: now,
      periodEnd: now,
      product: 'Widget X',
      topic: 'Battery life',
      sentiment: 'positive',
      sentimentConfidence: 0.91,
      evidenceCount: 184,
      conversationCount: 120,
    });

    expect(observation.product).toBe('Widget X');
    expect(observation.sentiment).toBe('positive');
    expect(observation.evidenceCount).toBe(184);
    // The type itself has no field for raw text - this is a structural
    // guarantee, not just a runtime one, but assert the real row shape too.
    expect(Object.keys(observation)).not.toContain('text');
    expect(Object.keys(observation)).not.toContain('rawText');
  });

  it('bi_observations.aggregateByProductTopic groups real counts correctly', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const repo = new BiObservationRepository(queryAsTenant(businessId));
    const periodStart = new Date(Date.now() - 86_400_000).toISOString();
    const periodEnd = new Date().toISOString();

    await repo.create({ businessId, sourceType: 'chat', periodStart, periodEnd, product: 'Widget X', topic: 'Battery', sentiment: 'positive', evidenceCount: 10, conversationCount: 8 });
    await repo.create({ businessId, sourceType: 'chat', periodStart, periodEnd, product: 'Widget X', topic: 'Battery', sentiment: 'positive', evidenceCount: 5, conversationCount: 4 });
    await repo.create({ businessId, sourceType: 'chat', periodStart, periodEnd, product: 'Widget Y', topic: 'Price', sentiment: 'negative', evidenceCount: 3, conversationCount: 3 });

    const aggregates = await repo.aggregateByProductTopic(businessId, periodStart, periodEnd);
    const widgetX = aggregates.find((a) => a.product === 'Widget X' && a.topic === 'Battery');
    expect(widgetX?.observationCount).toBe(2);
    expect(widgetX?.conversationCount).toBe(12);
  });

  it('bi_insights: only status=approved is meant to be surfaced by listApproved, and approvedAt is stamped only then', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const repo = new BiInsightRepository(queryAsTenant(businessId));
    const periodStart = new Date(Date.now() - 86_400_000).toISOString();
    const periodEnd = new Date().toISOString();

    const held = await repo.create({
      businessId, category: 'sentiment', title: 'Held insight', body: 'Not enough evidence yet.',
      periodStart, periodEnd, evidenceObservationCount: 2, evidenceConversationCount: 2,
      confidence: 'insufficient_data', status: 'held', qualityFlags: ['sample_size_too_small'],
    });
    expect(held.approvedAt).toBeNull();

    const approved = await repo.create({
      businessId, category: 'sentiment', title: 'Approved insight', body: 'Real, evidence-backed insight.',
      direction: 'increasing', metricChangePct: 28,
      periodStart, periodEnd, evidenceObservationCount: 412, evidenceConversationCount: 267,
      confidence: 'high', status: 'approved', qualityFlags: [],
    });
    expect(approved.approvedAt).not.toBeNull();

    const listed = await repo.listApproved(businessId);
    expect(listed.map((i) => i.id)).toEqual([approved.id]);
  });

  it('bi_security_alerts never stores the sensitive value itself - only the fact and type', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const repo = new BiSecurityAlertRepository(queryAsTenant(businessId));

    const alert = await repo.record({ businessId, alertType: 'pii_detected', sourceType: 'chat' });
    expect(alert.alertType).toBe('pii_detected');
    expect(Object.keys(alert)).not.toContain('value');
    expect(Object.keys(alert)).not.toContain('rawText');

    const recent = await repo.listRecent(businessId);
    expect(recent).toHaveLength(1);
  });

  it('customer_reviews: real create/list round-trip, currently a real but empty-until-populated source', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const repo = new CustomerReviewRepository(queryAsTenant(businessId));

    expect(await repo.listForBusinessSince(businessId, new Date(0).toISOString())).toEqual([]);

    const review = await repo.create({ businessId, source: 'manual', rating: 5, reviewText: 'Great service.' });
    expect(review.source).toBe('manual');

    const listed = await repo.listForBusinessSince(businessId, new Date(0).toISOString());
    expect(listed).toHaveLength(1);
  });

  it('every new table is tenant-isolated: business B never sees business A\'s rows', async () => {
    await resetDatabase();
    const businessA = await createTestBusiness('A');
    const businessB = await createTestBusiness('B');
    const now = new Date().toISOString();

    await new BiObservationRepository(queryAsTenant(businessA)).create({ businessId: businessA, sourceType: 'chat', periodStart: now, periodEnd: now, topic: 'A-only' });
    await new BiInsightRepository(queryAsTenant(businessA)).create({
      businessId: businessA, category: 'sentiment', title: 'A-only insight', body: 'A-only body',
      periodStart: now, periodEnd: now, evidenceObservationCount: 100, evidenceConversationCount: 50,
      confidence: 'high', status: 'approved', qualityFlags: [],
    });
    await new BiSecurityAlertRepository(queryAsTenant(businessA)).record({ businessId: businessA, alertType: 'pii_detected', sourceType: 'chat' });
    await new CustomerReviewRepository(queryAsTenant(businessA)).create({ businessId: businessA, reviewText: 'A-only review' });

    expect(await new BiObservationRepository(queryAsTenant(businessB)).listForPeriod(businessB, now, now)).toEqual([]);
    expect(await new BiInsightRepository(queryAsTenant(businessB)).listApproved(businessB)).toEqual([]);
    expect(await new BiSecurityAlertRepository(queryAsTenant(businessB)).listRecent(businessB)).toEqual([]);
    expect(await new CustomerReviewRepository(queryAsTenant(businessB)).listForBusinessSince(businessB, new Date(0).toISOString())).toEqual([]);
  });
});
