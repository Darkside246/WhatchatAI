import { pool, queryAsTenant } from '../db/pool.js';
import { BusinessRepository } from '../repositories/businessRepository.js';
import { CrmContactRepository, type CrmContactRecord } from '../repositories/crmContactRepository.js';
import { WhatsAppMessageRepository, type WhatsAppMessageRecord } from '../repositories/whatsappMessageRepository.js';
import { ConversationStateRepository, emptyConversationState, type ConversationStateRecord } from '../repositories/conversationStateRepository.js';
import { searchKnowledgeBase, type KnowledgeBaseSearchResult } from './knowledgeBaseSearchService.js';
import { retrieveAiDocumentContext, type AiDocumentRetrievalResponse } from './aiDocumentRetrievalService.js';
import { timeService, resolveBusinessTimezone, type TimeContext } from './time/timeService.js';
import { resolveInlineMediaPart, type InlineMediaPart } from './ai/mediaContext.js';

export interface GatherAiHandoffContextInput {
  businessId: string;
  chatId: string;
  contactId: string | null;
  queryText: string;
  historyLimit?: number;
  /** The triggering message's media row, when it has real, already-downloaded media the AI should actually see/hear - null for a text-only message or one whose media isn't available. */
  mediaId?: string | null;
}

export interface AiHandoffContext {
  /** Echoed back from the input - lets downstream consumers (e.g. agentGuard's tool-invocation audit log) stay self-contained without threading extra parameters through generateAiReply. */
  businessId: string;
  chatId: string;
  crmContact: CrmContactRecord | null;
  knowledgeBase: KnowledgeBaseSearchResult;
  /** D4-B: AI-retrievable business documents (D3-C's retrieveAiDocumentContext), gathered the same way and with the same {available, results, reason} contract as knowledgeBase above - never a second retrieval/trust pattern. */
  documentContext: AiDocumentRetrievalResponse;
  conversationHistory: WhatsAppMessageRecord[];
  /**
   * Durable structured state for this conversation (current goal, confirmed
   * facts, open questions) - supplements the raw history/CRM/knowledge-base
   * context above, never replaces it. Read-only here: gathering context
   * never creates a conversation_states row as a side effect (some callers
   * legitimately gather context for a chatId with no real whatsapp_chats
   * row yet), so a conversation with no real row gets a non-persisted
   * empty default (see emptyConversationState()) rather than a
   * lazily-created one. Nothing currently writes real goals/facts/questions
   * into this yet, so today every real conversation's state is empty -
   * included now so a future writer has somewhere to put it, and so the
   * prompt already knows how to surface it once one exists.
   */
  conversationState: ConversationStateRecord;
  /** Real IANA name from the business's own Settings, defaulting to 'UTC' - never guessed from the server's own clock. */
  businessTimezone: string;
  /** Authoritative, TimeService-built context (internet-synchronized where possible) - the AI must use this, never its own model knowledge, for "now". */
  timeContext: TimeContext;
  /** Real, decoded image/audio/video/document bytes for the triggering message, when eligible - null when there is none, it hasn't downloaded yet, or it isn't a Gemini-supported mimeType/size. */
  media: InlineMediaPart | null;
}

/**
 * Once a message clears the Sentinel and is decrypted in memory, this
 * gathers everything the Gemini Orchestrator needs concurrently instead of
 * sequentially: CRM contact lookup, Knowledge Base vector search,
 * conversation history, and the business's own timezone all run in parallel
 * via Promise.all(), so total latency is bounded by the slowest lookup, not
 * their sum.
 */
export async function gatherAiHandoffContext(input: GatherAiHandoffContextInput): Promise<AiHandoffContext> {
  // crm_contacts and whatsapp_messages have Postgres Row-Level Security
  // enabled (migration 944) as a database-enforced backstop for the
  // business_id filter already in every query below - scoped via
  // queryAsTenant(input.businessId) so RLS actually binds (see
  // db/pool.ts's own doc comment for why the bare pool can't be used for
  // this). businesses/conversation_states aren't in that RLS scope yet, so
  // they stay on the ordinary pool.
  const crmContactRepository = new CrmContactRepository(queryAsTenant(input.businessId));
  const messageRepository = new WhatsAppMessageRepository(queryAsTenant(input.businessId));
  const businessRepository = new BusinessRepository(pool);
  const conversationStateRepository = new ConversationStateRepository(pool);

  const [crmContact, knowledgeBase, documentContext, conversationHistory, business, media, conversationState] = await Promise.all([
    input.contactId
      ? crmContactRepository.findByWhatsAppContact(input.businessId, input.contactId)
      : Promise.resolve(null),
    searchKnowledgeBase(input.businessId, input.queryText),
    // Same businessId and queryText already used for searchKnowledgeBase
    // above - never a value derived from AI output, tool arguments, or
    // document content. retrieveAiDocumentContext's own repository query is
    // the sole enforcement point for tenant/version/deletion/ai_retrievable
    // scoping (D3-C); nothing here duplicates or bypasses it.
    retrieveAiDocumentContext(input.businessId, input.queryText),
    messageRepository.listByChat(input.chatId, input.historyLimit ?? 20),
    businessRepository.findById(input.businessId),
    input.mediaId ? resolveInlineMediaPart(input.businessId, input.mediaId) : Promise.resolve(null),
    conversationStateRepository.find(input.businessId, input.chatId),
  ]);

  const businessTimezone = resolveBusinessTimezone({ timezone: business?.timezone ?? null });
  const timeContext = timeService.buildContextForTimezone(businessTimezone, business ?? undefined);

  return {
    businessId: input.businessId,
    chatId: input.chatId,
    crmContact,
    knowledgeBase,
    documentContext,
    conversationHistory,
    conversationState: conversationState ?? emptyConversationState(input.businessId, input.chatId),
    businessTimezone,
    timeContext,
    media,
  };
}
