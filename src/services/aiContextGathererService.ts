import { pool } from '../db/pool.js';
import { BusinessRepository } from '../repositories/businessRepository.js';
import { CrmContactRepository, type CrmContactRecord } from '../repositories/crmContactRepository.js';
import { WhatsAppMessageRepository, type WhatsAppMessageRecord } from '../repositories/whatsappMessageRepository.js';
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
  const crmContactRepository = new CrmContactRepository(pool);
  const messageRepository = new WhatsAppMessageRepository(pool);
  const businessRepository = new BusinessRepository(pool);

  const [crmContact, knowledgeBase, documentContext, conversationHistory, business, media] = await Promise.all([
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
    businessTimezone,
    timeContext,
    media,
  };
}
