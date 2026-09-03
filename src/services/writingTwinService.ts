import { pool } from '../db/pool.js';
import { withTransaction } from '../db/transaction.js';
import { WritingTwinRepository, type WritingTwinSettingsRecord } from '../repositories/writingTwinRepository.js';
import { SecurityAuditLogRepository } from '../repositories/securityAuditLogRepository.js';
import type { BusinessExecutionContext } from '../domain/businessExecutionContext.js';
import type { ChannelScope, WritingTwinSignals } from '../domain/writingTwin/types.js';

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** W2-B S6: 30 examples per channel by default, environment-overridable. */
function getMaxExamplesPerChannel(): number {
  return envInt('WRITING_TWIN_MAX_EXAMPLES_PER_CHANNEL', 30);
}

/** W2-B S5: 60-day Tier C retention by default, environment-overridable. */
function getRawEventRetentionDays(): number {
  return envInt('WRITING_TWIN_RAW_EVENT_RETENTION_DAYS', 60);
}

export class UnauthorizedActorError extends Error {}

/** Every non-retrieval method requires a real, human, authenticated actor - a BusinessExecutionContext built for an AI cell or a system job is rejected here, the service-layer half of the fail-closed AI-attribution boundary (the repository-layer half is that no method anywhere accepts an agentId). */
function assertHumanActor(context: BusinessExecutionContext): asserts context is BusinessExecutionContext & { actorId: string } {
  if (context.actorType !== 'user' || !context.actorId) {
    throw new UnauthorizedActorError('Writing Twin operations require a real, authenticated human user context.');
  }
}

const repository = new WritingTwinRepository(pool);
const securityAuditLogRepository = new SecurityAuditLogRepository(pool);

export interface WritingTwinStyleSummary {
  channelScope: ChannelScope;
  signals: WritingTwinSignals;
  exampleCount: number;
}

export interface WritingTwinContextResult {
  available: boolean;
  profile: WritingTwinStyleSummary | null;
  reason: string | null;
}

export class WritingTwinService {
  async getSettings(context: BusinessExecutionContext): Promise<WritingTwinSettingsRecord> {
    assertHumanActor(context);
    const existing = await repository.getSettings(context.businessId, context.actorId);
    if (existing) return existing;
    // No settings row yet is equivalent to learning_enabled=false - never
    // requiring a row to exist before defaulting safely closed (W2-A S5).
    return {
      id: '',
      businessId: context.businessId,
      userId: context.actorId,
      learningEnabled: false,
      historicalBackfillRequestedAt: null,
      historicalBackfillCompletedAt: null,
      createdAt: '',
      updatedAt: '',
    };
  }

  async setLearningEnabled(context: BusinessExecutionContext, enabled: boolean): Promise<WritingTwinSettingsRecord> {
    assertHumanActor(context);
    const result = await repository.setLearningEnabled(context.businessId, context.actorId, enabled);
    await securityAuditLogRepository.record({
      businessId: context.businessId,
      eventType: enabled ? 'writing_twin_learning_enabled' : 'writing_twin_learning_disabled',
      rawMetadata: { userId: context.actorId, requestId: context.requestId },
    });
    return result;
  }

  /** W1-B S6: historical backfill is always a separate, explicit opt-in action - never a side effect of enabling learning. */
  async requestHistoricalBackfill(context: BusinessExecutionContext): Promise<void> {
    assertHumanActor(context);
    await repository.recordBackfillRequested(context.businessId, context.actorId);
    await securityAuditLogRepository.record({
      businessId: context.businessId,
      eventType: 'writing_twin_backfill_requested',
      rawMetadata: { userId: context.actorId, requestId: context.requestId },
    });
  }

  /**
   * The full deletion path (W2-B S4): one transaction across all four
   * tables (the fifth, writing_twin_profile_derivations, cascades
   * automatically from deleting profiles/examples). No cache exists to
   * invalidate today - the retrieval path below reads Postgres directly
   * on every call, so the very next call after this commits finds
   * nothing. Any future cache must extend this method to invalidate
   * itself inside this same call, not as a follow-up (W2-B's binding
   * requirement, not merely a hope).
   */
  async deleteAll(context: BusinessExecutionContext): Promise<void> {
    assertHumanActor(context);
    const { businessId, actorId: userId } = context;

    await withTransaction(async (client) => {
      const repo = new WritingTwinRepository(client);
      await repo.deleteRawEvents(businessId, userId);
      await repo.deleteStyleExamples(businessId, userId);
      await repo.deleteProfiles(businessId, userId);
      await repo.deleteSettings(businessId, userId);
    });

    await securityAuditLogRepository.record({
      businessId,
      eventType: 'writing_twin_deleted',
      rawMetadata: { userId, requestId: context.requestId },
    });
  }

  /** Clears Tier A/B (and their derivations, via cascade) without touching learning_enabled - distinct from deleteAll (W1-B S7/W2-A S10). */
  async resetProfile(context: BusinessExecutionContext): Promise<void> {
    assertHumanActor(context);
    const { businessId, actorId: userId } = context;

    await withTransaction(async (client) => {
      const repo = new WritingTwinRepository(client);
      await repo.deleteStyleExamples(businessId, userId);
      await repo.deleteProfiles(businessId, userId);
    });

    await securityAuditLogRepository.record({
      businessId,
      eventType: 'writing_twin_profile_reset',
      rawMetadata: { userId, requestId: context.requestId },
    });
  }

  async removeStyleExample(context: BusinessExecutionContext, exampleId: string): Promise<void> {
    assertHumanActor(context);
    await repository.deleteStyleExample(context.businessId, context.actorId, exampleId);
    await securityAuditLogRepository.record({
      businessId: context.businessId,
      eventType: 'writing_twin_example_removed',
      rawMetadata: { userId: context.actorId, exampleId, requestId: context.requestId },
    });
  }

  /**
   * Called only from within extraction/regeneration processing (W3's
   * eventual job, not built in this phase's wiring) with a real
   * businessId/userId already resolved server-side - never from a route
   * accepting these as request input. Locks per (business, user,
   * channel) via the repository's advisory-lock-guarded insert, so
   * concurrent additions can never jointly exceed the cap.
   */
  async recordApprovedExample(
    context: BusinessExecutionContext,
    channelScope: ChannelScope,
    provenance: 'human_authored' | 'ai_generated_then_edited' | 'explicitly_approved',
    exampleText: string,
    sourceTable: 'email_messages' | 'whatsapp_outbound_messages',
    sourceRowId: string,
  ) {
    assertHumanActor(context);
    return withTransaction(async (client) => {
      const repo = new WritingTwinRepository(client);
      return repo.addStyleExample(
        context.businessId,
        context.actorId,
        channelScope,
        provenance,
        exampleText,
        sourceTable,
        sourceRowId,
        getMaxExamplesPerChannel(),
      );
    });
  }

  /**
   * The AI retrieval boundary (W2-B S14). Deliberately takes plain
   * (businessId, userId, channelScope), matching
   * retrieveAiDocumentContext/searchKnowledgeBase's established
   * signature convention exactly - never a BusinessExecutionContext
   * here, since that would be an inconsistent deviation from that
   * proven pattern for this one call site.
   *
   * NOT wired into aiContextGathererService.ts's gatherAiHandoffContext
   * in this phase: GatherAiHandoffContextInput has no userId field, and
   * none is added by this phase, precisely because the autonomous
   * WhatsApp AI-agent reply path has no single human user to attribute
   * a personal Writing Twin to (W1-A S13, W2-B S14's fail-closed rule).
   * This function exists, is tested, and is ready for a future,
   * human-invoked feature (e.g. "draft this reply in my voice") that has
   * a real authenticated userId to pass - it is simply not called from
   * anywhere outside its own tests in this commit.
   */
  async retrieveWritingTwinContext(businessId: string, userId: string, channelScope: ChannelScope): Promise<WritingTwinContextResult> {
    try {
      const profile = await repository.getCurrentProfile(businessId, userId, channelScope);
      if (profile) {
        const stale = await repository.isProfileStale(businessId, userId, profile.id);
        if (!stale) {
          return {
            available: true,
            profile: {
              channelScope: profile.channelScope,
              signals: {
                preferredTone: profile.preferredTone,
                formality: profile.formality,
                greetingStyle: profile.greetingStyle,
                signOffStyle: profile.signOffStyle,
                avgSentenceLengthBucket: profile.avgSentenceLengthBucket,
                punctuationEmphasis: profile.punctuationEmphasis,
                emojiFrequency: profile.emojiFrequency,
                directness: profile.directness,
                questionPattern: profile.questionPattern,
                commonPhrases: profile.commonPhrases,
                commonSignOffs: profile.commonSignOffs,
              },
              exampleCount: profile.exampleCount,
            },
            reason: null,
          };
        }
      }

      // No channel-specific profile (or it is stale) - fall back to
      // 'global' exactly once, per W1-B S13's fallback hierarchy. Never
      // recurse further than one hop.
      if (channelScope !== 'global') {
        return this.retrieveWritingTwinContext(businessId, userId, 'global');
      }

      // No profile anywhere for this user - an honest, real empty
      // result, never fabricated (matches every other retrieval
      // service's {available, ...} contract in this codebase).
      return { available: true, profile: null, reason: null };
    } catch (error) {
      console.error('[WritingTwinService] Retrieval failed:', error);
      return {
        available: false,
        profile: null,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

export const writingTwinService = new WritingTwinService();

/**
 * Section 75-91 (data privacy/retention - "learning safeguards"): a real,
 * significant gap found - writingTwinRepository.ts's own
 * sweepExpiredRawEvents() has existed since this feature was built
 * (real DELETE FROM writing_twin_raw_events WHERE expires_at < now()),
 * with expires_at correctly computed at insert time from the documented
 * 60-day Tier C retention window - but nothing anywhere ever called it.
 * These rows hold real, encrypted human-authored/AI-edited writing
 * samples (up to 20,000 chars each) drawn from real email/WhatsApp
 * messages, meant by this feature's own design to expire after 60 days;
 * without this sweep they sat in the database forever. Wired in exactly
 * like every other real sweep (see incomingMessagesWorker.ts).
 */
export async function sweepExpiredWritingTwinRawEvents(): Promise<void> {
  const repository = new WritingTwinRepository(pool);
  const deleted = await repository.sweepExpiredRawEvents();
  if (deleted > 0) {
    console.log(`[RealtimeEventsWorker] Purged ${deleted} expired writing-twin raw event(s) past their 60-day retention window`);
  }
}
export { getMaxExamplesPerChannel, getRawEventRetentionDays };
