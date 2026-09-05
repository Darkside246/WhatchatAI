import { pool, queryAsTenant } from '../db/pool.js';
import { BusinessRepository } from '../repositories/businessRepository.js';
import { CrmContactRepository, type CrmContactRecord } from '../repositories/crmContactRepository.js';
import { WhatsAppContactRepository } from '../repositories/whatsappContactRepository.js';
import { WhatsAppMessageRepository, type WhatsAppMessageRecord } from '../repositories/whatsappMessageRepository.js';
import { ConversationStateRepository, emptyConversationState, type ConversationStateRecord } from '../repositories/conversationStateRepository.js';
import { CustomerMemoryRepository, emptyCustomerMemory, type CustomerMemoryRecord } from '../repositories/customerMemoryRepository.js';
import { ListScopedMemoryRepository, emptyListScopedMemory } from '../repositories/listScopedMemoryRepository.js';
import { ListAgentAssignmentRepository } from '../repositories/listAgentAssignmentRepository.js';
import { WhatsAppChatRepository } from '../repositories/whatsappChatRepository.js';
import { CustomerIdentityRepository } from '../repositories/customerIdentityRepository.js';
import { searchKnowledgeBase, type KnowledgeBaseSearchResult } from './knowledgeBaseSearchService.js';
import { retrieveAiDocumentContext, type AiDocumentRetrievalResponse } from './aiDocumentRetrievalService.js';
import { timeService, resolveBusinessTimezone, type TimeContext } from './time/timeService.js';
import { resolveInlineMediaPart, type InlineMediaPart } from './ai/mediaContext.js';
import { GoogleMeetingRepository } from '../repositories/googleMeetingRepository.js';
import { ZoomMeetingRepository } from '../repositories/zoomMeetingRepository.js';
import type { MeetingProvider } from './meeting/meetingProvider.js';
import { PropertyOperationsRepository } from '../repositories/propertyOperationsRepository.js';
import { RetailOperationsRepository } from '../repositories/retailOperationsRepository.js';
import { DEFAULT_NAME_USAGE_LEVEL } from './ai/identityEngine.js';
import { BusinessMembershipRepository } from '../repositories/businessMembershipRepository.js';
import { WritingTwinRepository } from '../repositories/writingTwinRepository.js';
import { writingTwinService, type WritingTwinContextResult } from './writingTwinService.js';

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
  /**
   * AURA Lists (Phase 1): this chat's currently-active List (whatsapp_chats.active_list_id),
   * when one is set. Null for any chat that has never used Lists, which is
   * the overwhelming default and changes nothing else in this context.
   */
  activeListId: string | null;
  /**
   * True only when activeListId is set AND that List's enabled agent
   * assignment has rememberListSpecificInfo=true. When true, customerMemory
   * above was populated from list_scoped_memory (business_id, activeListId,
   * customerId) INSTEAD OF the cross-list customer_memory table - the
   * concrete enforcement of Lists' hard-must isolation requirement (the
   * same customer's Work-list memory must never be visible under Friends,
   * and vice versa). The write side (aiReplyService.ts's call to
   * applyCustomerMemoryUpdate/applyListScopedMemoryUpdate) reads this flag
   * to decide which table to write back to, without re-querying.
   */
  listScopedMemoryEnabled: boolean;
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
  /** Same "never offer a tool with nothing real behind it" rule as hasPropertyData above, gating list_retail_products/check_retail_order_status. */
  hasRetailData: boolean;
  /**
   * Emergency "Stop All Agents" kill switch (businesses.ai_actions_paused).
   * The authoritative enforcement is agentGuard.ts's guardToolInvocation -
   * this field only lets buildReplyTools avoid offering a tool Gemini would
   * just have denied anyway, saving a wasted round trip.
   */
  aiActionsPaused: boolean;
  /** AI Agents Page Consolidation: businesses.customer_memory_enabled - real enforcement lives in conversationStateWriter.ts's applyCustomerMemoryUpdate, same "kill switch that still lets replies through" shape as aiActionsPaused above. */
  customerMemoryEnabled: boolean;
  /**
   * Personalisation Budget (directive §27): the business's own configured
   * Name Usage level (1-5, see identityEngine.ts's NAME_USAGE_COOLDOWN_MINUTES),
   * passed through to shouldUseName() so a business that has actually moved
   * the slider gets a real cooldown change, not the hardcoded default.
   */
  nameUsageLevel: number;
  /** Master on/off for name usage (businesses.name_usage_enabled) - see identityEngine.ts's shouldUseName for the real enforcement and its one carve-out. */
  nameUsageEnabled: boolean;
  /** Echoed back from the input (same reasoning as businessId/chatId above) - the one real source for detecting whether the customer's own current message asked to be addressed by name (identityEngine.ts's customerAskedToUseName). */
  queryText: string;
  /**
   * Sections 14-24 (Identity & Name Discovery Engine): the real WhatsApp
   * name fields for this contact, raw - never assumed to be a real name on
   * their own (see identityEngine.ts's resolveNameEvidence, which turns
   * these into evidence-classified confidence, not a bare display name).
   * Null for a group message or when no WhatsApp contact could be
   * resolved for this chat.
   */
  contactNameSources: {
    /** Section 23: a staff member's manual correction/confirmation from crm_contacts - identityEngine.ts's highest-priority tier. */
    staffConfirmedName: string | null;
    verifiedName: string | null;
    businessName: string | null;
    pushName: string | null;
    username: string | null;
    shortName: string | null;
  } | null;
  /**
   * AURA Learn Agent (Personal Communication Intelligence): the business
   * OWNER's Writing Twin profile, gated on TWO of the three required
   * checks here (learning_enabled AND share_with_agents_enabled) - the
   * third (per-agent access) can't be checked yet at gathering time,
   * since routeInboundMessage's agent decision runs concurrently with
   * this function (see aiOrchestrator.ts) and isn't known until after.
   * null whenever either business-level gate is off, or no owner/profile
   * exists - buildSystemInstruction (aiReplyService.ts) must additionally
   * check learnAllowedAgentIds.has(agent.id) before ever using this, so
   * "most restrictive wins" is still fully enforced across the two call
   * sites together.
   */
  communicationStyle: WritingTwinContextResult | null;
  /** The set of agentIds this owner has explicitly allowed (writing_twin_agent_access, allowed=true rows only) - empty whenever communicationStyle is null, since there was no point resolving it. */
  learnAllowedAgentIds: Set<string>;
}

/**
 * Resolves the two business-level Learn gates (learning_enabled AND
 * share_with_agents_enabled) for this business's OWNER and, only when
 * both are on, the current Writing Twin profile plus the set of agents
 * explicitly allowed to see it. Fails closed on any error or missing
 * owner/settings - an absent or half-configured Learn setup must never
 * throw and must never leak a profile.
 */
async function resolveLearnContext(businessId: string): Promise<{ communicationStyle: WritingTwinContextResult | null; learnAllowedAgentIds: Set<string> }> {
  try {
    const membershipRepository = new BusinessMembershipRepository(pool);
    const writingTwinRepository = new WritingTwinRepository(pool);

    const ownerUserId = await membershipRepository.findOwnerUserId(businessId);
    if (!ownerUserId) return { communicationStyle: null, learnAllowedAgentIds: new Set() };

    const settings = await writingTwinRepository.getSettings(businessId, ownerUserId);
    if (!settings?.learningEnabled || !settings.shareWithAgentsEnabled) {
      return { communicationStyle: null, learnAllowedAgentIds: new Set() };
    }

    const [communicationStyle, allowedAgentIds] = await Promise.all([
      writingTwinService.retrieveWritingTwinContext(businessId, ownerUserId, 'whatsapp'),
      writingTwinRepository.listAllowedAgentIds(businessId, ownerUserId),
    ]);
    return { communicationStyle, learnAllowedAgentIds: new Set(allowedAgentIds) };
  } catch (error) {
    console.error('[aiContextGathererService] Failed to resolve Learn context:', error instanceof Error ? error.message : error);
    return { communicationStyle: null, learnAllowedAgentIds: new Set() };
  }
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
  const whatsappContactRepository = new WhatsAppContactRepository(pool);
  const messageRepository = new WhatsAppMessageRepository(queryAsTenant(input.businessId));
  const businessRepository = new BusinessRepository(pool);
  const conversationStateRepository = new ConversationStateRepository(pool);
  const customerIdentityRepository = new CustomerIdentityRepository(pool);
  const customerMemoryRepository = new CustomerMemoryRepository(pool);
  const listScopedMemoryRepository = new ListScopedMemoryRepository(queryAsTenant(input.businessId));
  const listAgentAssignmentRepository = new ListAgentAssignmentRepository(queryAsTenant(input.businessId));
  const chatRepository = new WhatsAppChatRepository(queryAsTenant(input.businessId));
  const googleMeetingRepository = new GoogleMeetingRepository(pool);
  const zoomMeetingRepository = new ZoomMeetingRepository(pool);
  const propertyOperationsRepository = new PropertyOperationsRepository(pool);
  const retailOperationsRepository = new RetailOperationsRepository(pool);

  // A single, fast indexed lookup - resolved before the main batch below
  // since whether/what to fetch for customerMemory depends on it. null for
  // a group message or a contact never linked to a customer (see
  // whatsappMessagePersistenceService.ts's individual-only restriction on
  // creating that link in the first place).
  const customerId = input.contactId
    ? await customerIdentityRepository.findCustomerIdByIdentity(input.businessId, 'whatsapp', 'whatsapp_contact_id', input.contactId)
    : null;

  // AURA Lists (Phase 1): resolved before the main batch below, same
  // reasoning as customerId above - whether/which table customerMemory is
  // fetched from depends on it. A chat that has never used Lists has
  // activeListId === null here, so useListScopedMemory is always false and
  // every following line behaves identically to before this feature existed.
  const activeListChat = await chatRepository.findByIdForBusiness(input.chatId, input.businessId).catch(() => null);
  const activeListId = activeListChat?.activeListId ?? null;
  const activeListAssignment = activeListId
    ? await listAgentAssignmentRepository.findEnabledForList(input.businessId, activeListId).catch(() => null)
    : null;
  const useListScopedMemory = !!(activeListId && activeListAssignment?.rememberListSpecificInfo);

  const [crmContact, whatsappContact, knowledgeBase, documentContext, conversationHistory, business, media, conversationState, customerMemory, googleMeetingConnection, zoomMeetingConnection, properties, products, learnContext] = await Promise.all([
    input.contactId
      ? crmContactRepository.findByWhatsAppContact(input.businessId, input.contactId)
      : Promise.resolve(null),
    // Sections 14-24 (Identity & Name Discovery Engine) - the real name
    // sources identityEngine.ts resolves evidence from. Never assumed to
    // be a real name just because it's here (see that module's own doc
    // comment) - this is raw material, not a resolved identity.
    input.contactId ? whatsappContactRepository.findById(input.contactId) : Promise.resolve(null),
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
    customerId
      ? (useListScopedMemory
          ? listScopedMemoryRepository.find(input.businessId, activeListId!, customerId)
          : customerMemoryRepository.find(input.businessId, customerId))
      : Promise.resolve(null),
    googleMeetingRepository.getConnectionByBusiness(input.businessId),
    zoomMeetingRepository.getConnectionByBusiness(input.businessId),
    propertyOperationsRepository.listProperties(input.businessId),
    retailOperationsRepository.listProducts(input.businessId),
    resolveLearnContext(input.businessId),
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
    customerMemory: customerId
      ? (customerMemory ?? (useListScopedMemory ? emptyListScopedMemory(input.businessId, activeListId!, customerId) : emptyCustomerMemory(input.businessId, customerId)))
      : null,
    activeListId,
    listScopedMemoryEnabled: useListScopedMemory,
    businessTimezone,
    timeContext,
    media,
    connectedMeetingProviders,
    hasPropertyData: properties.length > 0,
    hasRetailData: products.length > 0,
    aiActionsPaused: business?.aiActionsPaused ?? false,
    customerMemoryEnabled: business?.customerMemoryEnabled ?? true,
    nameUsageLevel: business?.nameUsageLevel ?? DEFAULT_NAME_USAGE_LEVEL,
    nameUsageEnabled: business?.nameUsageEnabled ?? true,
    queryText: input.queryText,
    // Guarded on either source existing, not just whatsappContact - a
    // staff-confirmed name (crmContact) must still resolve even in the
    // (normally-impossible-but-not-guaranteed) case the WhatsApp contact
    // row itself is unavailable, since it's the single highest-priority
    // tier identityEngine.ts has.
    contactNameSources: whatsappContact || crmContact
      ? {
          staffConfirmedName: crmContact?.manualDisplayName ?? null,
          verifiedName: whatsappContact?.verifiedName ?? null,
          businessName: whatsappContact?.businessName ?? null,
          pushName: whatsappContact?.pushName ?? null,
          username: whatsappContact?.username ?? null,
          shortName: whatsappContact?.shortName ?? null,
        }
      : null,
    communicationStyle: learnContext.communicationStyle,
    learnAllowedAgentIds: learnContext.learnAllowedAgentIds,
  };
}
