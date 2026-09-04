import { describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { TriageFeedbackRepository } from '../src/repositories/triageFeedbackRepository.js';
import { RetailTriageFeedbackRepository } from '../src/repositories/retailTriageFeedbackRepository.js';
import { createTestBusiness, resetDatabase } from './helpers.js';

/**
 * Section 75-91 follow-up: this is a real, working few-shot calibration
 * loop (property's maintenance triage and retail's order triage both
 * inject the last 8 staff approve/reject decisions into the AI prompt as
 * examples - see propertyMaintenanceAgentService.ts/retailAgentService.ts)
 * with zero test coverage anywhere before this. The one thing that
 * actually matters here is tenant isolation: a leaked cross-business
 * example inside a triage prompt would be a real data leak, not just an
 * accuracy bug - one business's real guest/customer message text
 * appearing as "calibration" in a different business's AI prompt.
 */
describe('TriageFeedbackRepository (property) - tenant isolation and ordering (real Postgres)', () => {
  it('never returns another business\'s feedback examples', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const otherBusinessId = await createTestBusiness('Other Business');
    const repo = new TriageFeedbackRepository(pool);

    await repo.record({ businessId: otherBusinessId, actionRequestId: null, messageText: 'Other business real guest message', aiCategory: 'HVAC', aiUrgency: 'PRIORITY', aiConfidence: 0.8, humanDecision: 'APPROVED', decisionReason: null });
    await repo.record({ businessId, actionRequestId: null, messageText: 'This business\'s own message', aiCategory: 'WATER', aiUrgency: 'ROUTINE', aiConfidence: 0.6, humanDecision: 'REJECTED', decisionReason: 'false positive' });

    const examples = await repo.getRecentExamples(businessId);
    expect(examples).toHaveLength(1);
    expect(examples[0]?.messageText).toBe('This business\'s own message');
    const serialized = JSON.stringify(examples);
    expect(serialized).not.toContain('Other business real guest message');
  });

  it('returns examples newest-first and respects the limit', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const repo = new TriageFeedbackRepository(pool);

    for (const label of ['first', 'second', 'third']) {
      await repo.record({ businessId, actionRequestId: null, messageText: label, aiCategory: 'OTHER', aiUrgency: 'ROUTINE', aiConfidence: 0.5, humanDecision: 'APPROVED', decisionReason: null });
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const limited = await repo.getRecentExamples(businessId, 2);
    expect(limited).toHaveLength(2);
    expect(limited.map((e) => e.messageText)).toEqual(['third', 'second']);
  });

  it('returns an empty list, never an error, for a business with no feedback history yet', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const repo = new TriageFeedbackRepository(pool);
    expect(await repo.getRecentExamples(businessId)).toEqual([]);
  });
});

describe('RetailTriageFeedbackRepository - tenant isolation and ordering (real Postgres)', () => {
  it('never returns another business\'s feedback examples', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const otherBusinessId = await createTestBusiness('Other Business');
    const repo = new RetailTriageFeedbackRepository(pool);

    await repo.record({ businessId: otherBusinessId, actionRequestId: null, messageText: 'Other business real customer message', aiCategory: 'NEW_ORDER', aiUrgency: 'ROUTINE', aiConfidence: 0.8, humanDecision: 'APPROVED', decisionReason: null });
    await repo.record({ businessId, actionRequestId: null, messageText: 'This business\'s own message', aiCategory: 'COMPLAINT', aiUrgency: 'ESCALATE', aiConfidence: 0.6, humanDecision: 'REJECTED', decisionReason: 'not urgent' });

    const examples = await repo.getRecentExamples(businessId);
    expect(examples).toHaveLength(1);
    expect(examples[0]?.messageText).toBe('This business\'s own message');
    const serialized = JSON.stringify(examples);
    expect(serialized).not.toContain('Other business real customer message');
  });

  it('returns examples newest-first and respects the limit', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const repo = new RetailTriageFeedbackRepository(pool);

    for (const label of ['first', 'second', 'third']) {
      await repo.record({ businessId, actionRequestId: null, messageText: label, aiCategory: 'GENERAL_INQUIRY', aiUrgency: 'ROUTINE', aiConfidence: 0.5, humanDecision: 'APPROVED', decisionReason: null });
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const limited = await repo.getRecentExamples(businessId, 2);
    expect(limited).toHaveLength(2);
    expect(limited.map((e) => e.messageText)).toEqual(['third', 'second']);
  });
});
