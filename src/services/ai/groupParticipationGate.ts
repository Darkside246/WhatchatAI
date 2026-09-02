import { classifyJid, stripDeviceSuffix } from '../../domain/whatsapp/jid.js';
import type { WhatsAppChatRecord } from '../../repositories/whatsappChatRepository.js';
import type { WhatsAppMessageRecord, WhatsAppMessageRepository } from '../../repositories/whatsappMessageRepository.js';
import type { WhatsAppAccountRepository } from '../../repositories/whatsappAccountRepository.js';
import type { WhatsAppGroupRepository } from '../../repositories/whatsappGroupRepository.js';
import type { WhatsAppJidMappingRepository } from '../../repositories/whatsappJidMappingRepository.js';

/**
 * Group-chat AI participation gate. A DM (chat.isGroup === false) never
 * reaches this module at all - both call sites (incomingMessagesWorker.ts's
 * processAiDebounce/maybeTriggerMediaAiHandoff) branch on isGroup before
 * calling in. Everything here answers one question: given a burst of
 * unanswered group messages, should the AI actually speak, and if so,
 * which of those messages is the real trigger versus unrelated chatter
 * from other participants that happened to arrive in the same window?
 *
 * Deterministic and explainable by design - not a trained/ML relevance
 * model (no training pipeline or labeled data exists in this codebase).
 * Every evaluation logs its full decision (see logGateDecision in
 * incomingMessagesWorker.ts) specifically so it could become exactly that
 * dataset later, if a human's own override of a decision is ever recorded
 * as the label - not something this module needs to anticipate today.
 */

function clampedEnvInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

export const AI_GROUP_ACTIVITY_WINDOW_MS = clampedEnvInt('AI_GROUP_ACTIVITY_WINDOW_MS', 300_000, 30_000, 3_600_000);
export const AI_GROUP_QUIET_MAX_MESSAGES = clampedEnvInt('AI_GROUP_QUIET_MAX_MESSAGES', 4, 0, 1000);
export const AI_GROUP_QUIET_MAX_SENDERS = clampedEnvInt('AI_GROUP_QUIET_MAX_SENDERS', 2, 0, 1000);
export const AI_GROUP_BUSY_MIN_MESSAGES = clampedEnvInt('AI_GROUP_BUSY_MIN_MESSAGES', 12, 1, 100_000);
export const AI_GROUP_BUSY_MIN_SENDERS = clampedEnvInt('AI_GROUP_BUSY_MIN_SENDERS', 5, 1, 100_000);
export const AI_GROUP_LARGE_SIZE_THRESHOLD = clampedEnvInt('AI_GROUP_LARGE_SIZE_THRESHOLD', 30, 1, 100_000);
export const AI_GROUP_MENTION_COOLDOWN_MS = clampedEnvInt('AI_GROUP_MENTION_COOLDOWN_MS', 8_000, 0, 600_000);
export const AI_GROUP_IMPLICIT_COOLDOWN_QUIET_MS = clampedEnvInt('AI_GROUP_IMPLICIT_COOLDOWN_QUIET_MS', 45_000, 0, 3_600_000);
export const AI_GROUP_IMPLICIT_COOLDOWN_MODERATE_MS = clampedEnvInt('AI_GROUP_IMPLICIT_COOLDOWN_MODERATE_MS', 90_000, 0, 3_600_000);

export type GroupActivityBucket = 'quiet' | 'moderate' | 'busy';
export type GroupParticipationTrigger = 'mention' | 'reply_to_bot' | 'implicit' | 'always_on' | 'none';

export interface GroupParticipationGateResult {
  participate: boolean;
  trigger: GroupParticipationTrigger;
  /** The subset of candidateMessages that is the real trigger - only these get joined into the AI's queryText. Empty when participate is false. */
  triggerMessages: WhatsAppMessageRecord[];
  activityBucket: GroupActivityBucket;
  messageCount: number;
  distinctSenders: number;
  participantsCount: number | null;
  cooldownRemainingMs: number | null;
  reason: string;
}

export interface GroupParticipationGateDeps {
  messageRepository: Pick<WhatsAppMessageRepository, 'countRecentActivity' | 'findById'>;
  accountRepository: Pick<WhatsAppAccountRepository, 'findById'>;
  groupRepository: Pick<WhatsAppGroupRepository, 'findById'>;
  jidMappingRepository: Pick<WhatsAppJidMappingRepository, 'findByLid'>;
}

/** Trailing run of messages at the end of the slice sharing the last message's sender - a burst from one person, not the whole room. */
function selectTrailingSameSenderRun(batch: WhatsAppMessageRecord[]): WhatsAppMessageRecord[] {
  if (batch.length === 0) return [];
  const last = batch[batch.length - 1]!;
  let start = batch.length - 1;
  while (start > 0 && batch[start - 1]!.senderJid === last.senderJid) start -= 1;
  return batch.slice(start);
}

function looksLikeQuestionOrRequest(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (trimmed.endsWith('?')) return true;
  return /^(who|what|when|where|why|how|is|are|can|could|would|will|should|do|does|did)\b/i.test(trimmed);
}

async function mentionsAccount(
  mentionedJids: string[],
  accountJid: string,
  businessId: string,
  whatsappAccountId: string,
  jidMappingRepository: GroupParticipationGateDeps['jidMappingRepository'],
): Promise<boolean> {
  for (const raw of mentionedJids) {
    const stripped = stripDeviceSuffix(raw);
    if (stripped === accountJid) return true;
    if (classifyJid(stripped) === 'lid') {
      const mapping = await jidMappingRepository.findByLid(businessId, whatsappAccountId, stripped);
      if (mapping?.phoneJid && stripDeviceSuffix(mapping.phoneJid) === accountJid) return true;
    }
  }
  return false;
}

/**
 * Scans candidateMessages most-recent-first for an explicit address
 * (mention or a reply to one of the bot's own prior messages). Returns
 * the index of the first (most recent) such message, or -1.
 */
async function findExplicitAddressIndex(
  candidateMessages: WhatsAppMessageRecord[],
  accountJid: string | null,
  businessId: string,
  whatsappAccountId: string,
  deps: GroupParticipationGateDeps,
): Promise<{ index: number; trigger: 'mention' | 'reply_to_bot' } | null> {
  for (let i = candidateMessages.length - 1; i >= 0; i -= 1) {
    const message = candidateMessages[i]!;

    if (message.quotedMessageId) {
      const quoted = await deps.messageRepository.findById(message.quotedMessageId);
      if (quoted?.fromMe) return { index: i, trigger: 'reply_to_bot' };
    }

    if (accountJid) {
      const mentionedJids = Array.isArray(message.rawMetadata?.mentionedJids) ? (message.rawMetadata.mentionedJids as string[]) : [];
      if (mentionedJids.length > 0 && (await mentionsAccount(mentionedJids, accountJid, businessId, whatsappAccountId, deps.jidMappingRepository))) {
        return { index: i, trigger: 'mention' };
      }
    }
  }
  return null;
}

async function computeActivity(
  chat: WhatsAppChatRecord,
  deps: GroupParticipationGateDeps,
): Promise<{ bucket: GroupActivityBucket; messageCount: number; distinctSenders: number; participantsCount: number | null }> {
  const sinceIso = new Date(Date.now() - AI_GROUP_ACTIVITY_WINDOW_MS).toISOString();
  const { messageCount, distinctSenders } = await deps.messageRepository.countRecentActivity(chat.id, sinceIso);

  let bucket: GroupActivityBucket;
  if (messageCount >= AI_GROUP_BUSY_MIN_MESSAGES || distinctSenders >= AI_GROUP_BUSY_MIN_SENDERS) bucket = 'busy';
  else if (messageCount <= AI_GROUP_QUIET_MAX_MESSAGES && distinctSenders <= AI_GROUP_QUIET_MAX_SENDERS) bucket = 'quiet';
  else bucket = 'moderate';

  let participantsCount: number | null = null;
  if (chat.groupId) {
    const group = await deps.groupRepository.findById(chat.groupId);
    participantsCount = group?.participantsCount ?? null;
    // Group size is a secondary modifier, not an independent score - it
    // shifts the activity-derived bucket one step toward busy, it never
    // overrides a bucket the message activity itself already computed.
    if (participantsCount !== null && participantsCount > AI_GROUP_LARGE_SIZE_THRESHOLD) {
      if (bucket === 'quiet') bucket = 'moderate';
      else if (bucket === 'moderate') bucket = 'busy';
    }
  }

  return { bucket, messageCount, distinctSenders, participantsCount };
}

function cooldownRemaining(lastAiGroupReplyAt: string | null, cooldownMs: number): number {
  if (!lastAiGroupReplyAt) return 0;
  const elapsed = Date.now() - new Date(lastAiGroupReplyAt).getTime();
  return Math.max(0, cooldownMs - elapsed);
}

export interface GroupParticipationGateInput {
  chat: WhatsAppChatRecord;
  /** Chronological (oldest first), the same batch the caller is about to consider - see incomingMessagesWorker.ts's two call sites. */
  candidateMessages: WhatsAppMessageRecord[];
}

export async function evaluateGroupParticipationGate(
  input: GroupParticipationGateInput,
  deps: GroupParticipationGateDeps,
): Promise<GroupParticipationGateResult> {
  const { chat, candidateMessages } = input;
  const empty = (reason: string, activityBucket: GroupActivityBucket = 'quiet'): GroupParticipationGateResult => ({
    participate: false,
    trigger: 'none',
    triggerMessages: [],
    activityBucket,
    messageCount: 0,
    distinctSenders: 0,
    participantsCount: null,
    cooldownRemainingMs: null,
    reason,
  });

  if (candidateMessages.length === 0) return empty('no candidate messages');
  if (chat.groupParticipationMode === 'OFF') return empty('group_participation_mode is OFF');

  const account = await deps.accountRepository.findById(chat.whatsappAccountId);
  const accountJid = account?.whatsappJid ? stripDeviceSuffix(account.whatsappJid) : null;

  const explicit = await findExplicitAddressIndex(candidateMessages, accountJid, chat.businessId, chat.whatsappAccountId, deps);

  if (explicit) {
    const remaining = cooldownRemaining(chat.lastAiGroupReplyAt, AI_GROUP_MENTION_COOLDOWN_MS);
    if (remaining > 0) {
      return { ...empty(`explicit address (${explicit.trigger}) suppressed by mention cooldown`, 'quiet'), cooldownRemainingMs: remaining };
    }
    const triggerMessages = selectTrailingSameSenderRun(candidateMessages.slice(0, explicit.index + 1));
    return {
      participate: true,
      trigger: explicit.trigger,
      triggerMessages,
      activityBucket: 'quiet',
      messageCount: 0,
      distinctSenders: 0,
      participantsCount: null,
      cooldownRemainingMs: null,
      reason: `explicit address (${explicit.trigger})`,
    };
  }

  if (chat.groupParticipationMode === 'MENTIONS_ONLY') return empty('group_participation_mode is MENTIONS_ONLY and no explicit address found');

  if (chat.groupParticipationMode === 'ALWAYS_ON') {
    const remaining = cooldownRemaining(chat.lastAiGroupReplyAt, AI_GROUP_MENTION_COOLDOWN_MS);
    if (remaining > 0) return { ...empty('ALWAYS_ON suppressed by cooldown', 'quiet'), cooldownRemainingMs: remaining };
    return {
      participate: true,
      trigger: 'always_on',
      triggerMessages: selectTrailingSameSenderRun(candidateMessages),
      activityBucket: 'quiet',
      messageCount: 0,
      distinctSenders: 0,
      participantsCount: null,
      cooldownRemainingMs: null,
      reason: 'group_participation_mode is ALWAYS_ON',
    };
  }

  // AUTO from here down: no explicit address, so willingness to speak
  // scales inversely with how busy the group currently is.
  const activity = await computeActivity(chat, deps);
  if (activity.bucket === 'busy') {
    return { ...empty('busy group with no explicit address', activity.bucket), messageCount: activity.messageCount, distinctSenders: activity.distinctSenders, participantsCount: activity.participantsCount };
  }

  const triggerMessages = selectTrailingSameSenderRun(candidateMessages);
  const triggerText = triggerMessages.map((m) => m.textContent).filter((t): t is string => Boolean(t)).join('\n');
  if (!looksLikeQuestionOrRequest(triggerText)) {
    return { ...empty(`${activity.bucket} group, no explicit address, and message doesn't look like a question/request`, activity.bucket), messageCount: activity.messageCount, distinctSenders: activity.distinctSenders, participantsCount: activity.participantsCount };
  }

  const implicitCooldownMs = activity.bucket === 'quiet' ? AI_GROUP_IMPLICIT_COOLDOWN_QUIET_MS : AI_GROUP_IMPLICIT_COOLDOWN_MODERATE_MS;
  const remaining = cooldownRemaining(chat.lastAiGroupReplyAt, implicitCooldownMs);
  if (remaining > 0) {
    return { ...empty(`implicit relevance suppressed by ${activity.bucket} cooldown`, activity.bucket), messageCount: activity.messageCount, distinctSenders: activity.distinctSenders, participantsCount: activity.participantsCount, cooldownRemainingMs: remaining };
  }

  return {
    participate: true,
    trigger: 'implicit',
    triggerMessages,
    activityBucket: activity.bucket,
    messageCount: activity.messageCount,
    distinctSenders: activity.distinctSenders,
    participantsCount: activity.participantsCount,
    cooldownRemainingMs: null,
    reason: `implicit relevance in a ${activity.bucket} group`,
  };
}
