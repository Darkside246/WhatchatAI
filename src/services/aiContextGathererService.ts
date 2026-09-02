import { pool, queryAsTenant } from '../db/pool.js';
import { BusinessRepository } from '../repositories/businessRepository.js';
import { CrmContactRepository, type CrmContactRecord } from '../repositories/crmContactRepository.js';
import { WhatsAppMessageRepository, type WhatsAppMessageRecord } from '../repositories/whatsappMessageRepository.js';
import { ConversationStateRepository, emptyConversationState, type ConversationStateRecord } from '../repositories/conversationStateRepository.js';
import { CustomerMemoryRepository, emptyCustomerMemory, type CustomerMemoryRecord } from '../repositories/customerMemoryRepository.js';
import { CustomerIdentityRepository } from '../repositories/customerIdentityRepository.js';
import { searchKnowledgeBase, type KnowledgeBaseSearchResult } from './knowledgeBaseSearchService.js';
import { retrieveAiDocumentContext, type AiDocumentRetrievalResponse } from './aiDocumentRetrievalService.js';
import { timeService, resolveBusinessTimezone, type TimeContext } from './time/timeService.js';
import { resolveInlineMediaPart, type InlineMediaPart } from './ai/mediaContext.js';
import { GoogleMeetingRepository } from '../repositories/googleMeetingRepository.js';
import { ZoomMeetingRepository } from '../repositories/zoomMeetingRepository.js';
import type { MeetingProvider } from './meeting/meetingProvider.js';
import { PropertyOperationsRepository } from '../repositories/propertyOperationsRepository.js';

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
   * lazily-created one. Written by the model itself via the
   * update_conversation_memory tool (see conversationStateWriter.ts).
   */
  conversationState: ConversationStateRecord;
  /**
   * Layer 2 of "layered memory" (migration 959) - facts confirmed by this
   * same customer in any PAST conversation, resolved via the
   * channel-agnostic customer identity (migration 928), never just this
   * chat's own history. null when no customer could be resolved for this
   * chat (a group message, or a contact never linked to a customer) -
   * distinct from "resolved but empty," which is a real CustomerMemoryRecord
   * with an empty confirmedFacts array.
   */
  customerId: string | null;
  customerMemory: CustomerMemoryRecord | null;
  /** Real IANA name from the business's own Settings, defaulting to 'UTC' - never guessed from the server's own clock. */
  businessTimezone: string;
  /** Authoritative, TimeService-built context (internet-synchronized where possible) - the AI must use this, never its own model knowledge, for "now". */
  timeContext: TimeContext;
  /** Real, decoded image/audio/video/document bytes for the triggering message, when eligible - null when there is none, it hasn't downloaded yet, or it isn't a Gemini-supported mimeType/size. */
  media: InlineMediaPart | null;
  /**
   * Which meeting-booking provider(s) this business has actually connected
   * (google_meet, zoom, both, or neither) - decided once here rather than
   * re-checked per tool call, since Gemini gets exactly one round of tool
   * calls per reply (see aiReplyService.ts's buildReplyTools): offering a
   * tool for an unconnected provider would waste that one shot on a
   * guaranteed not_connected.
   */
  connectedMeetingProviders: MeetingProvider[];
  /**
   * Whether this business has any real property_properties rows at all -
   * gates list_properties/check_property_status the same way
   * connectedMeetingProviders gates the meeting tools, so a non-property
   * business's agent is never handed a tool that would only ever return an
   * empty result.
   */
  hasPropertyData: boolean;
  /**
   * Emergency "Stop All Agents" kill switch (businesses.ai_actions_paused).
   * The authoritative enforcement is agentGuard.ts's guardToolInvocation -
   * this field only lets buildReplyTools avoid offering a tool Gemini would
   * just have denied anyway, saving a wasted round trip.
   */
  aiActionsPaused: boolean;
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
  const customerIdentityRepository = new CustomerIdentityRepository(pool);
  const customerMemoryRepository = new CustomerMemoryRepository(pool);
  const googleMeetingRepository = new GoogleMeetingRepository(pool);
  const zoomMeetingRepository = new ZoomMeetingRepository(pool);
  const propertyOperationsRepository = new PropertyOperationsRepository(pool);

  // A single, fast indexed lookup - resolved before the main batch below
  // since whether/what to fetch for customerMemory depends on it. null for
  // a group message or a contact never linked to a customer (see
  // whatsappMessagePersistenceService.ts's individual-only restriction on
  // creating that link in the first place).
  const customerId = input.contactId
    ? await customerIdentityRepository.findCustomerIdByIdentity(input.businessId, 'whatsapp', 'whatsapp_contact_id', input.contactId)
    : null;

  const [crmContact, knowledgeBase, documentContext, conversationHistory, business, media, conversationState, customerMemory, googleMeetingConnection, zoomMeetingConnection, properties] = await Promise.all([
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
    customerId ? customerMemoryRepository.find(input.businessId, customerId) : Promise.resolve(null),
    googleMeetingRepository.getConnectionByBusiness(input.businessId),
    zoomMeetingRepository.getConnectionByBusiness(input.businessId),
    propertyOperationsRepository.listProperties(input.businessId),
  ]);

  const businessTimezone = resolveBusinessTimezone({ timezone: business?.timezone ?? null });
  const timeContext = timeService.buildContextForTimezone(businessTimezone, business ?? undefined);

  const connectedMeetingProviders: MeetingProvider[] = [
    ...(googleMeetingConnection ? (['google_meet'] as const) : []),
    ...(zoomMeetingConnection ? (['zoom'] as const) : []),
  ];

  return {
    businessId: input.businessId,
    chatId: input.chatId,
    crmContact,
    knowledgeBase,
    documentContext,
    conversationHistory,
    conversationState: conversationState ?? emptyConversationState(input.businessId, input.chatId),
    customerId,
    customerMemory: customerId ? (customerMemory ?? emptyCustomerMemory(input.businessId, customerId)) : null,
    businessTimezone,
    timeContext,
    media,
    connectedMeetingProviders,
    hasPropertyData: properties.length > 0,
    aiActionsPaused: business?.aiActionsPaused ?? false,
  };
}
