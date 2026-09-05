import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { WritingTwinRepository } from '../src/repositories/writingTwinRepository.js';
import {
  computeSignalsFromExamples,
  describeCommunicationStyle,
  promoteEligibleRawEvents,
  computeProfile,
  runLearnAnalysisSweep,
} from '../src/services/learn/writingStyleAnalyzer.js';
import { createTestBusiness, createTestUser, resetDatabase } from './helpers.js';

const repository = new WritingTwinRepository(pool);

describe('computeSignalsFromExamples (pure, deterministic - no database, no LLM call)', () => {
  it('returns an all-null/empty signal set for zero examples, never a fabricated default', () => {
    const signals = computeSignalsFromExamples([]);
    expect(signals.preferredTone).toBeNull();
    expect(signals.emojiFrequency).toBeNull();
    expect(signals.commonPhrases).toEqual([]);
  });

  it('is deterministic - the exact same input always produces the exact same output', () => {
    const examples = ['Hey! Thanks so much 😊 talk soon!', 'Sure, no problem at all.', 'Can you send that over? Thanks!'];
    expect(computeSignalsFromExamples(examples)).toEqual(computeSignalsFromExamples(examples));
  });

  it('detects short, emoji-heavy, casual writing as concise/casual with a real emoji frequency', () => {
    const examples = ['Hi! 😊', 'Sure thing 👍', 'On it!', 'Thanks!! 🙏'];
    const signals = computeSignalsFromExamples(examples);
    expect(signals.preferredTone).toBe('concise');
    expect(signals.avgSentenceLengthBucket).toBe('short');
    expect(signals.emojiFrequency).not.toBe('none');
  });

  it('detects long, formal, no-emoji writing as detailed/formal with no emoji', () => {
    const examples = [
      'Thank you for reaching out regarding your recent inquiry about our services, and I would be happy to provide additional information regarding the scope of what we offer.',
      'Please let me know if you require any further clarification regarding the terms outlined in the attached document, as we want to ensure complete clarity before proceeding.',
    ];
    const signals = computeSignalsFromExamples(examples);
    expect(signals.emojiFrequency).toBe('none');
    expect(signals.avgSentenceLengthBucket).toBe('long');
  });

  it('caps commonPhrases/commonSignOffs at the schema-documented bounds (8 items/80 chars, 5 items/40 chars)', () => {
    const repeated = Array.from({ length: 20 }, (_, i) => `let me check on that for you right away number ${i}`);
    const signals = computeSignalsFromExamples(repeated);
    expect(signals.commonPhrases.length).toBeLessThanOrEqual(8);
    expect(signals.commonPhrases.every((p) => p.length <= 80)).toBe(true);
    expect(signals.commonSignOffs.length).toBeLessThanOrEqual(5);
    expect(signals.commonSignOffs.every((p) => p.length <= 40)).toBe(true);
  });
});

describe('describeCommunicationStyle (the prompt-facing formatter)', () => {
  it('returns an empty string for an all-null signal set - never a hallucinated description', () => {
    expect(describeCommunicationStyle(computeSignalsFromExamples([]))).toBe('');
  });

  it('frames the description as stylistic influence, never as content/instructions to say', () => {
    const description = describeCommunicationStyle(computeSignalsFromExamples(['Hey! Thanks so much 😊', 'Sure, on it!']));
    expect(description.toLowerCase()).not.toContain('you must say');
    expect(description).toContain('never what to say');
  });
});

describe('promoteEligibleRawEvents + computeProfile (real Postgres integration)', () => {
  let businessId: string;
  let userId: string;

  beforeEach(async () => {
    await resetDatabase();
    businessId = await createTestBusiness('Analyzer Business');
    userId = await createTestUser(businessId);
  });

  it('promotes unprocessed raw events into style examples and marks them processed either way', async () => {
    await repository.recordRawEvent(businessId, userId, 'whatsapp', 'human_authored', 'Thanks so much!', null, 'whatsapp_outbound_messages', randomUUID(), 60);
    await repository.recordRawEvent(businessId, userId, 'whatsapp', 'human_authored', 'Sure, no problem.', null, 'whatsapp_outbound_messages', randomUUID(), 60);

    const promoted = await promoteEligibleRawEvents(businessId, userId, 'whatsapp');
    expect(promoted).toBe(2);

    // Every raw event is marked processed - a second run promotes nothing new.
    expect(await promoteEligibleRawEvents(businessId, userId, 'whatsapp')).toBe(0);
    expect(await repository.listUnprocessedRawEvents(businessId, userId, 'whatsapp')).toEqual([]);

    const examples = await repository.listStyleExamples(businessId, userId, 'whatsapp', 10);
    expect(examples).toHaveLength(2);
  });

  it('computeProfile is honestly a no-op (returns null) when there are no style examples yet', async () => {
    expect(await computeProfile(businessId, userId, 'whatsapp')).toBeNull();
    expect(await repository.getCurrentProfile(businessId, userId, 'whatsapp')).toBeNull();
  });

  it('computeProfile writes a real current profile version derived from every surviving example', async () => {
    await repository.recordRawEvent(businessId, userId, 'whatsapp', 'human_authored', 'Hey! Thanks so much 😊', null, 'whatsapp_outbound_messages', randomUUID(), 60);
    await repository.recordRawEvent(businessId, userId, 'whatsapp', 'human_authored', 'Sure thing, on it now!', null, 'whatsapp_outbound_messages', randomUUID(), 60);
    await promoteEligibleRawEvents(businessId, userId, 'whatsapp');

    const profile = await computeProfile(businessId, userId, 'whatsapp');
    expect(profile?.exampleCount).toBe(2);
    expect(profile?.isCurrent).toBe(true);

    const current = await repository.getCurrentProfile(businessId, userId, 'whatsapp');
    expect(current?.id).toBe(profile?.id);
  });

  it('runLearnAnalysisSweep only picks up (business, user) pairs with learning_enabled=true, and skips a business with none', async () => {
    const learningOffBusinessId = await createTestBusiness('No Learning Business');
    const learningOffUserId = await createTestUser(learningOffBusinessId);
    await repository.recordRawEvent(learningOffBusinessId, learningOffUserId, 'whatsapp', 'human_authored', 'Should never be promoted.', null, 'whatsapp_outbound_messages', randomUUID(), 60);

    await repository.setLearningEnabled(businessId, userId, true);
    await repository.recordRawEvent(businessId, userId, 'whatsapp', 'human_authored', 'Hi there! Thanks for waiting.', null, 'whatsapp_outbound_messages', randomUUID(), 60);

    await runLearnAnalysisSweep();

    expect(await repository.getCurrentProfile(businessId, userId, 'whatsapp')).not.toBeNull();
    expect(await repository.listUnprocessedRawEvents(learningOffBusinessId, learningOffUserId, 'whatsapp')).toHaveLength(1);
  });
});
