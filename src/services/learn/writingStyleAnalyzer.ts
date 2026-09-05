import { pool } from '../../db/pool.js';
import { withTransaction } from '../../db/transaction.js';
import { WritingTwinRepository } from '../../repositories/writingTwinRepository.js';
import { SecurityAuditLogRepository } from '../../repositories/securityAuditLogRepository.js';
import { writingTwinService, getMaxExamplesPerChannel } from '../writingTwinService.js';
import { businessExecutionContextForUser } from '../../domain/businessExecutionContext.js';
import type { ChannelScope, WritingTwinSignals } from '../../domain/writingTwin/types.js';

const repository = new WritingTwinRepository(pool);
const securityAuditLogRepository = new SecurityAuditLogRepository(pool);

const EMOJI_REGEX = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu;
const HEDGE_WORDS = ['maybe', 'perhaps', 'might', 'could', 'i think', 'i guess', 'possibly', 'probably', 'kind of', 'sort of'];
const GREETING_WORDS = ['hi', 'hello', 'hey', 'dear', 'good morning', 'good afternoon', 'good evening'];
const SIGNOFF_WORDS = ['thanks', 'thank you', 'best', 'regards', 'cheers', 'talk soon', 'see you'];

/**
 * Every threshold below is a stated, documented assumption tuned by eye
 * against plausible real messages, not measured from real usage data
 * (which doesn't exist yet for any business using this) - same "revisit
 * once real data exists" honesty as the AI Token Top-Up pricing model
 * elsewhere in this codebase. Deliberately deterministic/rule-based, not
 * an LLM classification call, per the user's own scoping decision.
 */
function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function wordsIn(text: string): string[] {
  return text.split(/\s+/).filter((w) => w.length > 0);
}

function bucketSentenceLength(avgWords: number): WritingTwinSignals['avgSentenceLengthBucket'] {
  if (avgWords <= 7) return 'short';
  if (avgWords <= 15) return 'medium';
  return 'long';
}

function bucketEmojiFrequency(avgPerMessage: number): WritingTwinSignals['emojiFrequency'] {
  if (avgPerMessage <= 0) return 'none';
  if (avgPerMessage < 0.3) return 'low';
  if (avgPerMessage < 1) return 'moderate';
  return 'high';
}

function bucketPunctuationEmphasis(avgEmphasisMarksPerMessage: number): WritingTwinSignals['punctuationEmphasis'] {
  if (avgEmphasisMarksPerMessage < 0.2) return 'low';
  if (avgEmphasisMarksPerMessage < 0.8) return 'moderate';
  return 'high';
}

function bucketQuestionPattern(questionRatio: number): WritingTwinSignals['questionPattern'] {
  if (questionRatio < 0.1) return 'rare';
  if (questionRatio < 0.4) return 'occasional';
  return 'frequent';
}

function detectStyle(examples: string[], words: string[]): { greeting: WritingTwinSignals['greetingStyle']; signOff: WritingTwinSignals['signOffStyle'] } {
  let greetingHits = 0;
  let signOffHits = 0;
  let warmMarkers = 0;
  for (const text of examples) {
    const lower = text.toLowerCase();
    const firstLine = lower.split('\n')[0] ?? '';
    const lastLine = lower.split('\n').slice(-1)[0] ?? '';
    if (GREETING_WORDS.some((g) => firstLine.includes(g))) greetingHits += 1;
    if (SIGNOFF_WORDS.some((s) => lastLine.includes(s))) signOffHits += 1;
    if (/!|:\)|:d|❤|🙏|😊/u.test(lower)) warmMarkers += 1;
  }
  const total = examples.length || 1;
  const warm = warmMarkers / total > 0.3;
  return {
    greeting: greetingHits / total < 0.1 ? 'none' : warm ? 'warm' : 'minimal',
    signOff: signOffHits / total < 0.1 ? 'none' : warm ? 'warm' : 'minimal',
  };
}

function topNgrams(examples: string[], maxItems: number, maxCharsPerItem: number, n: 1 | 2 = 2): string[] {
  const counts = new Map<string, number>();
  for (const text of examples) {
    const words = wordsIn(text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ''));
    for (let i = 0; i + n <= words.length; i += 1) {
      const phrase = words.slice(i, i + n).join(' ');
      if (phrase.length === 0 || phrase.length > maxCharsPerItem) continue;
      counts.set(phrase, (counts.get(phrase) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .filter(([, count]) => count >= 2) // must recur at least twice - a one-off phrase is not a "common" one
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxItems)
    .map(([phrase]) => phrase);
}

/** Pure, deterministic - the same set of example texts always produces the same signals. Exported directly for unit testing without a database. */
export function computeSignalsFromExamples(exampleTexts: string[]): WritingTwinSignals {
  if (exampleTexts.length === 0) {
    return {
      preferredTone: null,
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

  const allWords = exampleTexts.flatMap(wordsIn);
  const allSentences = exampleTexts.flatMap(splitSentences);
  const avgSentenceWords = allSentences.length > 0 ? allWords.length / allSentences.length : allWords.length;

  const emojiCount = exampleTexts.reduce((sum, t) => sum + (t.match(EMOJI_REGEX)?.length ?? 0), 0);
  const emphasisCount = exampleTexts.reduce((sum, t) => sum + (t.match(/!+|\?{2,}|\.{3,}/g)?.length ?? 0), 0);
  const questionCount = exampleTexts.reduce((sum, t) => sum + (t.match(/\?/g)?.length ?? 0), 0);

  const lowerAll = exampleTexts.join(' \n ').toLowerCase();
  const hedgeHits = HEDGE_WORDS.reduce((sum, phrase) => sum + (lowerAll.split(phrase).length - 1), 0);
  const hedgeRatio = allSentences.length > 0 ? hedgeHits / allSentences.length : 0;

  const contractionHits = (lowerAll.match(/\b\w+'(?:re|ve|ll|d|m|t|s)\b/g) ?? []).length;
  const formalityScore = contractionHits / Math.max(allSentences.length, 1);

  const { greeting, signOff } = detectStyle(exampleTexts, allWords);

  return {
    preferredTone: avgSentenceWords <= 9 ? 'concise' : avgSentenceWords <= 18 ? 'balanced' : 'detailed',
    formality: formalityScore > 0.3 ? 'casual' : formalityScore > 0.1 ? 'neutral' : 'formal',
    greetingStyle: greeting,
    signOffStyle: signOff,
    avgSentenceLengthBucket: bucketSentenceLength(avgSentenceWords),
    punctuationEmphasis: bucketPunctuationEmphasis(emphasisCount / exampleTexts.length),
    emojiFrequency: bucketEmojiFrequency(emojiCount / exampleTexts.length),
    directness: hedgeRatio > 0.25 ? 'hedged' : hedgeRatio > 0.08 ? 'balanced' : 'direct',
    questionPattern: bucketQuestionPattern(questionCount / Math.max(allSentences.length, 1)),
    commonPhrases: topNgrams(exampleTexts, 8, 80, 2),
    commonSignOffs: topNgrams(exampleTexts, 5, 40, 1).filter((p) => SIGNOFF_WORDS.some((s) => p.includes(s.split(' ')[0] ?? s))),
  };
}

/**
 * Promotes any unprocessed raw events for this (business, user, channel)
 * into real style examples (up to the existing per-channel cap), marking
 * every raw event processed either way - a rejected/capped event is never
 * retried in a future run.
 */
export async function promoteEligibleRawEvents(businessId: string, userId: string, channelScope: Exclude<ChannelScope, 'global'>): Promise<number> {
  const rawEvents = await repository.listUnprocessedRawEvents(businessId, userId, channelScope);
  // recordApprovedExample's own assertHumanActor guard requires
  // actorType 'user' - satisfied honestly here because this really is a
  // real, already-resolved (business, user) pair (the business's OWNER),
  // matching that method's own doc comment ("a real businessId/userId
  // already resolved server-side"), not a live human HTTP request.
  const ownerContext = businessExecutionContextForUser(businessId, userId);
  let promoted = 0;

  for (const event of rawEvents) {
    try {
      const example = await writingTwinService.recordApprovedExample(
        ownerContext,
        channelScope,
        event.provenance,
        event.finalText,
        event.sourceTable,
        event.sourceRowId,
      );
      if (example) promoted += 1;
    } catch (error) {
      console.error('[writingStyleAnalyzer] Failed to promote a raw event to a style example:', error instanceof Error ? error.message : error);
    } finally {
      await repository.markRawEventProcessed(businessId, userId, event.id);
    }
  }

  return promoted;
}

/**
 * Recomputes and stores a new current profile version for this channel
 * from every surviving style example - deterministic rule-based
 * measurement (see the bucket/threshold functions above), never an LLM
 * call. No-ops honestly (returns null) when there are no examples yet,
 * rather than writing a meaningless all-null profile version.
 */
export async function computeProfile(businessId: string, userId: string, channelScope: ChannelScope) {
  const examples = await repository.listStyleExamples(businessId, userId, channelScope, getMaxExamplesPerChannel());
  if (examples.length === 0) return null;

  const signals = computeSignalsFromExamples(examples.map((e) => e.exampleText));
  const profile = await withTransaction(async (client) => {
    const repo = new WritingTwinRepository(client);
    return repo.createProfileVersion(businessId, userId, channelScope, signals, examples.map((e) => e.id));
  });

  await securityAuditLogRepository.record({
    businessId,
    eventType: 'writing_twin_profile_computed',
    rawMetadata: { userId, channelScope, exampleCount: examples.length, profileVersion: profile.versionNumber },
  });

  return profile;
}

/**
 * Turns bounded-enum style signals into 1-2 natural-language sentences
 * for the prompt (aiReplyService.ts's buildSystemInstruction). Framed
 * throughout as stylistic influence on phrasing, never as identity or
 * impersonation instructions, and never as content to say - matches the
 * spec's explicit "not literal identity impersonation" rule.
 */
export function describeCommunicationStyle(signals: WritingTwinSignals): string {
  const traits: string[] = [];
  if (signals.formality) traits.push(signals.formality === 'casual' ? 'informal' : signals.formality === 'formal' ? 'formal' : 'neutral in formality');
  if (signals.preferredTone) traits.push(signals.preferredTone === 'concise' ? 'concise' : signals.preferredTone === 'detailed' ? 'detailed' : 'balanced in length');
  if (signals.emojiFrequency && signals.emojiFrequency !== 'none') traits.push(`uses emoji ${signals.emojiFrequency === 'high' ? 'often' : signals.emojiFrequency === 'moderate' ? 'sometimes' : 'sparingly'}`);
  if (signals.directness === 'direct') traits.push('direct and to the point');
  else if (signals.directness === 'hedged') traits.push('gentle and hedged rather than blunt');

  if (traits.length === 0) return '';
  return `This business's owner typically writes in a way that is ${traits.join(', ')} - let this gently inform phrasing, never what to say or any factual content.`;
}

/** Runs the full promote -> compute pipeline for one (business, user, channel) - the actual work the scheduled sweep triggers. */
export async function runLearnAnalysisFor(businessId: string, userId: string, channelScope: Exclude<ChannelScope, 'global'>): Promise<void> {
  const promoted = await promoteEligibleRawEvents(businessId, userId, channelScope);
  if (promoted > 0) {
    await computeProfile(businessId, userId, channelScope);
  }
}

/**
 * The scheduled entry point (see incomingMessagesWorker.ts's
 * 'learn-analysis-sweep' job, run alongside the existing writing-twin
 * retention sweep). Finds every (business, user) pair with learning
 * enabled and at least one unprocessed raw event, and runs the pipeline
 * for whichever channel(s) that user actually has pending events in -
 * never runs inline on the message-send path (async by design, per the
 * spec's own non-blocking requirement).
 */
export async function runLearnAnalysisSweep(): Promise<void> {
  const { rows } = await pool.query<{ business_id: string; user_id: string; channel_scope: Exclude<ChannelScope, 'global'> }>(
    `SELECT DISTINCT r.business_id, r.user_id, r.channel_scope
     FROM writing_twin_raw_events r
     JOIN writing_twin_settings s ON s.business_id = r.business_id AND s.user_id = r.user_id
     WHERE s.learning_enabled = true AND r.processed_at IS NULL AND r.expires_at > now()`,
  );

  for (const row of rows) {
    try {
      await runLearnAnalysisFor(row.business_id, row.user_id, row.channel_scope);
    } catch (error) {
      console.error('[writingStyleAnalyzer] Learn analysis sweep failed for one (business, user, channel):', error instanceof Error ? error.message : error);
    }
  }
}
