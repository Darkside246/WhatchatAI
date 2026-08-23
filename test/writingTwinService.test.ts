import { readFile } from 'node:fs/promises';
import { beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { WritingTwinRepository } from '../src/repositories/writingTwinRepository.js';
import { WritingTwinService, UnauthorizedActorError } from '../src/services/writingTwinService.js';
import { businessExecutionContextForUser, businessExecutionContextForAiCell, businessExecutionContextForSystem } from '../src/domain/businessExecutionContext.js';
import { createTestBusiness, createTestUser, resetDatabase } from './helpers.js';

const service = new WritingTwinService();

describe('WritingTwinService (Phase W3 - fail-closed AI-attribution boundary, deletion propagation, retrieval)', () => {
  let businessId: string;
  let userId: string;

  beforeEach(async () => {
    await resetDatabase();
    businessId = await createTestBusiness('Twin Business');
    userId = await createTestUser(businessId);
  });

  it('16. every mutating method rejects a non-user actorType (AI cell or system context)', async () => {
    const aiContext = businessExecutionContextForAiCell(businessId, 'cell-1');
    const systemContext = businessExecutionContextForSystem(businessId);

    await expect(service.setLearningEnabled(aiContext, true)).rejects.toThrow(UnauthorizedActorError);
    await expect(service.setLearningEnabled(systemContext, true)).rejects.toThrow(UnauthorizedActorError);
    await expect(service.deleteAll(aiContext)).rejects.toThrow(UnauthorizedActorError);
    await expect(service.resetProfile(aiContext)).rejects.toThrow(UnauthorizedActorError);
    await expect(service.requestHistoricalBackfill(aiContext)).rejects.toThrow(UnauthorizedActorError);
    await expect(service.removeStyleExample(aiContext, 'irrelevant-id')).rejects.toThrow(UnauthorizedActorError);
    await expect(service.getSettings(aiContext)).rejects.toThrow(UnauthorizedActorError);
  });

  it('a real user context succeeds where an AI/system context is rejected', async () => {
    const userContext = businessExecutionContextForUser(businessId, userId);
    await expect(service.setLearningEnabled(userContext, true)).resolves.toMatchObject({ learningEnabled: true });
  });

  it('17. retrieveWritingTwinContext falls back channel -> global -> none, and never further', async () => {
    const repo = new WritingTwinRepository(pool);

    // No profile anywhere yet - honest empty result.
    const empty = await service.retrieveWritingTwinContext(businessId, userId, 'email');
    expect(empty).toEqual({ available: true, profile: null, reason: null });

    // Only a global profile exists - an email-scoped request must fall back to it.
    await repo.createProfileVersion(businessId, userId, 'global', signalsWith('balanced'), []);
    const fellBackToGlobal = await service.retrieveWritingTwinContext(businessId, userId, 'email');
    expect(fellBackToGlobal.available).toBe(true);
    expect(fellBackToGlobal.profile?.channelScope).toBe('global');
    expect(fellBackToGlobal.profile?.signals.preferredTone).toBe('balanced');

    // Once an email-specific profile exists, it takes priority over global.
    await repo.createProfileVersion(businessId, userId, 'email', signalsWith('concise'), []);
    const channelSpecific = await service.retrieveWritingTwinContext(businessId, userId, 'email');
    expect(channelSpecific.profile?.channelScope).toBe('email');
    expect(channelSpecific.profile?.signals.preferredTone).toBe('concise');
  });

  it('18. a stale current profile (its evidence was deleted) is treated as unusable and falls back exactly like a missing one', async () => {
    const repo = new WritingTwinRepository(pool);
    const example = await repo.addStyleExample(businessId, userId, 'email', 'human_authored', 'Real example.', 'email_messages', crypto.randomUUID(), 30);
    await repo.createProfileVersion(businessId, userId, 'email', signalsWith('detailed'), [example!.id]);
    await repo.deleteStyleExample(businessId, userId, example!.id);

    const result = await service.retrieveWritingTwinContext(businessId, userId, 'email');
    // Stale in 'email', no 'global' profile exists either - honest empty, not the stale data.
    expect(result).toEqual({ available: true, profile: null, reason: null });
  });

  it('19. retrieveWritingTwinContext fails closed on a real failure - never a fabricated result', async () => {
    const result = await service.retrieveWritingTwinContext('not-a-valid-uuid', userId, 'email');
    expect(result.available).toBe(false);
    expect(result.profile).toBeNull();
    expect(result.reason).not.toBeNull();
  });

  it('20. historical backfill never runs as a side effect of enabling learning alone', async () => {
    const userContext = businessExecutionContextForUser(businessId, userId);
    await service.setLearningEnabled(userContext, true);

    const settings = await service.getSettings(userContext);
    expect(settings.historicalBackfillRequestedAt).toBeNull();

    await service.requestHistoricalBackfill(userContext);
    const afterExplicitRequest = await service.getSettings(userContext);
    expect(afterExplicitRequest.historicalBackfillRequestedAt).not.toBeNull();
  });

  it('21. deleteAll removes every tier for the exact (business, user) pair and leaves other users/businesses untouched', async () => {
    const repo = new WritingTwinRepository(pool);
    const otherUserId = await createTestUser(businessId);
    const userContext = businessExecutionContextForUser(businessId, userId);

    await service.setLearningEnabled(userContext, true);
    const example = await repo.addStyleExample(businessId, userId, 'email', 'human_authored', 'Mine.', 'email_messages', crypto.randomUUID(), 30);
    await repo.createProfileVersion(businessId, userId, 'email', signalsWith('concise'), [example!.id]);
    await repo.recordRawEvent(businessId, userId, 'email', 'human_authored', 'Mine raw.', null, 'email_messages', crypto.randomUUID(), 60);

    // A second user's real data, untouched by the first user's deletion.
    await service.setLearningEnabled(businessExecutionContextForUser(businessId, otherUserId), true);
    await repo.addStyleExample(businessId, otherUserId, 'email', 'human_authored', 'Theirs.', 'email_messages', crypto.randomUUID(), 30);

    await service.deleteAll(userContext);

    expect(await repo.getSettings(businessId, userId)).toBeNull();
    expect(await repo.getCurrentProfile(businessId, userId, 'email')).toBeNull();
    expect(await repo.listStyleExamples(businessId, userId, 'email', 10)).toEqual([]);
    expect(await repo.listUnprocessedRawEvents(businessId, userId, 'email')).toEqual([]);

    // The other user's data survives completely.
    expect(await repo.getSettings(businessId, otherUserId)).not.toBeNull();
    expect(await repo.listStyleExamples(businessId, otherUserId, 'email', 10)).toHaveLength(1);
  });

  it('22. retrieveWritingTwinContext is not called from the WhatsApp AI-agent reply path in this commit (structural check)', async () => {
    const source = await readFile(new URL('../src/services/aiContextGathererService.ts', import.meta.url), 'utf8');
    expect(source).not.toContain('retrieveWritingTwinContext');
    expect(source).not.toContain('writingTwinService');

    // GatherAiHandoffContextInput itself carries no userId field - there is
    // nothing to pass to Writing Twin retrieval from this path even if a
    // future change tried, without first adding one deliberately.
    const inputInterfaceMatch = source.match(/interface GatherAiHandoffContextInput \{([\s\S]*?)\n\}/);
    expect(inputInterfaceMatch).not.toBeNull();
    expect(inputInterfaceMatch?.[1]).not.toContain('userId');
  });
});

function signalsWith(preferredTone: 'concise' | 'balanced' | 'detailed') {
  return {
    preferredTone,
    formality: null,
    greetingStyle: null,
    signOffStyle: null,
    avgSentenceLengthBucket: null,
    punctuationEmphasis: null,
    emojiFrequency: null,
    directness: null,
    questionPattern: null,
    commonPhrases: [],
    commonSignOffs: [],
  };
}
