import { pool } from '../db/pool.js';
import { resolveDisplayName, type ContactNameSources } from '../domain/whatsapp/displayName.js';
import { WhatsAppAccountRepository } from '../repositories/whatsappAccountRepository.js';
import { BusinessRepository, type BusinessRecord } from '../repositories/businessRepository.js';
import { WhatsAppChatRepository, type ChatAiMode } from '../repositories/whatsappChatRepository.js';
import { WhatsAppContactRepository } from '../repositories/whatsappContactRepository.js';
import { WhatsAppMessageRepository } from '../repositories/whatsappMessageRepository.js';
import { WhatsAppSyncJobRepository } from '../repositories/whatsappSyncJobRepository.js';
import { CrmContactRepository, type UpdateCrmContactInput } from '../repositories/crmContactRepository.js';
import { LeadRepository, type UpdateLeadInput, type LeadRecord } from '../repositories/leadRepository.js';
import { AiAgentRepository, type AiAgentRecord } from '../repositories/aiAgentRepository.js';
import { EntitlementService, type EntitlementDenialReason } from './entitlementService.js';
import { SubscriptionRepository } from '../repositories/subscriptionRepository.js';
import { PlanRepository } from '../repositories/planRepository.js';
import { WhatsAppJidMappingRepository } from '../repositories/whatsappJidMappingRepository.js';
import { WhatsAppCallRepository } from '../repositories/whatsappCallRepository.js';
import { WhatsAppStatusRepository } from '../repositories/whatsappStatusRepository.js';
import { WhatsAppMediaRepository } from '../repositories/whatsappMediaRepository.js';
import { WhatsAppPresenceRepository } from '../repositories/whatsappPresenceRepository.js';
import { WhatsAppMessageReactionRepository } from '../repositories/whatsappMessageReactionRepository.js';
import { WhatsAppOutboundMessageRepository } from '../repositories/whatsappOutboundMessageRepository.js';
import type { WhatsAppMessageRecord } from '../repositories/whatsappMessageRepository.js';
import { classifyJid, derivePhoneNumber } from '../domain/whatsapp/jid.js';
import { describeMessageType } from '../domain/whatsapp/messagePreview.js';
import { whatsappConnectionService } from './whatsappConnectionService.js';
import type {
  CallStatus,
  CallType,
  MediaDownloadStatus,
  MediaType,
  MessageDirection,
  PresenceState,
} from '../domain/whatsapp/types.js';
import type { AgentStatus, LeadStatus, SubscriptionStatus } from '../domain/platform/types.js';

export interface WorkspaceChatSummary {
  id: string;
  chatJid: string;
  chatType: string;
  displayName: string;
  phoneNumber: string | null;
  unreadCount: number;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  aiMode: ChatAiMode;
  /** A real, non-expired status exists for this chat's JID right now - WhatsApp's own "status ring" signal. */
  hasActiveStatus: boolean;
  /** The real count of active statuses for this JID - the ring divides into exactly this many segments, same as WhatsApp's own UI. */
  activeStatusCount: number;
  /** This contact's real, downloaded profile picture media row - null for groups and until a sync has actually succeeded. */
  avatarMediaId: string | null;
}

export interface WorkspaceCallSummary {
  id: string;
  remoteJid: string;
  displayName: string;
  phoneNumber: string | null;
  callType: CallType;
  direction: MessageDirection;
  status: CallStatus;
  isVideo: boolean;
  isGroup: boolean;
  startedAt: string | null;
  endedAt: string | null;
  durationSeconds: number | null;
}

export interface WorkspaceStatusSummary {
  id: string;
  publisherJid: string;
  displayName: string;
  statusType: 'text' | 'image' | 'video' | 'audio' | 'unknown';
  textContent: string | null;
  media: WorkspaceMediaSummary | null;
  /** True only once the real media bytes are actually downloaded - never fabricated. */
  mediaAvailable: boolean;
  createdAt: string;
  expiresAt: string | null;
}

export interface WorkspaceMediaSummary {
  id: string;
  mediaType: MediaType;
  mimeType: string | null;
  fileName: string | null;
  fileSize: number | null;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  downloadStatus: MediaDownloadStatus;
}

export interface WorkspaceReactionSummary {
  reactorJid: string;
  reaction: string;
}

export interface WorkspacePresenceSummary {
  state: PresenceState;
  lastSeenAt: string | null;
}

export interface WorkspaceMessageSummary extends WhatsAppMessageRecord {
  media: WorkspaceMediaSummary | null;
  reactions: WorkspaceReactionSummary[];
  /** True only when the AI reply pipeline sent this message - never inferred, read from the real dispatch record. */
  aiGenerated: boolean;
}

export interface ChatNotFoundError extends Error {
  code: 'CHAT_NOT_FOUND';
}

function isChatNotFoundError(error: unknown): error is ChatNotFoundError {
  return error instanceof Error && (error as ChatNotFoundError).code === 'CHAT_NOT_FOUND';
}

export { isChatNotFoundError };

export interface EntitlementDeniedError extends Error {
  code: 'ENTITLEMENT_DENIED';
  reason: EntitlementDenialReason;
  limit?: number | null | undefined;
  current?: number | undefined;
}

export function isEntitlementDeniedError(error: unknown): error is EntitlementDeniedError {
  return error instanceof Error && (error as EntitlementDeniedError).code === 'ENTITLEMENT_DENIED';
}

export interface CrmContactNotFoundError extends Error {
  code: 'CRM_CONTACT_NOT_FOUND';
}

export function isCrmContactNotFoundError(error: unknown): error is CrmContactNotFoundError {
  return error instanceof Error && (error as CrmContactNotFoundError).code === 'CRM_CONTACT_NOT_FOUND';
}

export interface LeadNotFoundError extends Error {
  code: 'LEAD_NOT_FOUND';
}

export function isLeadNotFoundError(error: unknown): error is LeadNotFoundError {
  return error instanceof Error && (error as LeadNotFoundError).code === 'LEAD_NOT_FOUND';
}

export interface WorkspaceCrmContactSummary {
  id: string;
  whatsappContactId: string | null;
  displayName: string;
  phoneNumber: string | null;
  source: string | null;
  stage: string | null;
  leadStatus: string | null;
  tags: string[];
  notes: string | null;
  updatedAt: string;
}

export interface WorkspaceLeadSummary {
  id: string;
  crmContactId: string;
  displayName: string;
  phoneNumber: string | null;
  source: string | null;
  stage: string | null;
  status: LeadStatus;
  score: number | null;
  value: number | null;
  nextAction: string | null;
  notes: string | null;
  lastActivityAt: string | null;
  updatedAt: string;
}

export interface CreateLeadInput {
  crmContactId: string;
  source?: string | null | undefined;
  stage?: string | null | undefined;
  score?: number | null | undefined;
  value?: number | null | undefined;
  nextAction?: string | null | undefined;
  notes?: string | null | undefined;
}

export interface WorkspaceDashboardOverview {
  periodDays: number;
  messages: { inbound: number; outbound: number };
  chats: { total: number; activeSince: number };
  calls: Partial<Record<CallStatus, number>>;
  outboundReplies: { human: number; ai: number };
}

export interface WorkspaceBillingEntitlement {
  key: string;
  label: string;
  isEnabled: boolean;
  limit: number | null;
  /** Null when no real, counted usage source exists for this entitlement yet - never a fabricated number. */
  current: number | null;
}

export interface WorkspaceBillingOverview {
  plan: {
    name: string;
    planKey: string;
    priceMonthlyCents: number;
    currency: string;
  } | null;
  subscription: {
    status: SubscriptionStatus;
    currentPeriodStart: string | null;
    currentPeriodEnd: string | null;
    trialEndsAt: string | null;
    cancelledAt: string | null;
  } | null;
  entitlements: WorkspaceBillingEntitlement[];
}

const BILLING_ENTITLEMENT_LABELS: Record<string, string> = {
  max_ai_agents: 'AI Agents',
  max_whatsapp_accounts: 'WhatsApp Accounts',
  max_users: 'Team Members',
  advanced_analytics: 'Advanced Analytics',
};

export interface CreateAgentInput {
  name: string;
  description?: string | null | undefined;
  persona?: string | null | undefined;
  tone?: string | null | undefined;
  language?: string | null | undefined;
  systemInstruction?: string | null | undefined;
  greeting?: string | null | undefined;
  businessContext?: string | null | undefined;
  responseStyle?: string | null | undefined;
  humanTakeoverPolicy?: string | null | undefined;
}

export class WorkspaceService {
  private readonly accountRepository = new WhatsAppAccountRepository(pool);
  private readonly businessRepository = new BusinessRepository(pool);
  private readonly chatRepository = new WhatsAppChatRepository(pool);
  private readonly contactRepository = new WhatsAppContactRepository(pool);
  private readonly messageRepository = new WhatsAppMessageRepository(pool);
  private readonly syncJobRepository = new WhatsAppSyncJobRepository(pool);
  private readonly crmContactRepository = new CrmContactRepository(pool);
  private readonly leadRepository = new LeadRepository(pool);
  private readonly agentRepository = new AiAgentRepository(pool);
  private readonly entitlementService = new EntitlementService(pool);
  private readonly subscriptionRepository = new SubscriptionRepository(pool);
  private readonly planRepository = new PlanRepository(pool);
  private readonly jidMappingRepository = new WhatsAppJidMappingRepository(pool);
  private readonly callRepository = new WhatsAppCallRepository(pool);
  private readonly statusRepository = new WhatsAppStatusRepository(pool);
  private readonly mediaRepository = new WhatsAppMediaRepository(pool);
  private readonly presenceRepository = new WhatsAppPresenceRepository(pool);
  private readonly reactionRepository = new WhatsAppMessageReactionRepository(pool);
  private readonly outboundMessageRepository = new WhatsAppOutboundMessageRepository(pool);

  async listChats(businessId: string, whatsappAccountId: string): Promise<WorkspaceChatSummary[]> {
    const chats = await this.chatRepository.listByAccount(businessId, whatsappAccountId);
    const activeStatusCounts = await this.statusRepository.countActiveByPublisher(businessId, whatsappAccountId);
    const summaries: WorkspaceChatSummary[] = [];

    for (const chat of chats) {
      // Status updates, broadcast lists, and newsletters aren't conversations
      // - WhatsApp's own client keeps them out of the chat list too. Real
      // individual/group chats only, here.
      if (chat.chatType !== 'individual' && chat.chatType !== 'group') continue;

      let phoneNumber = chat.phoneNumber;
      let avatarMediaId: string | null = null;
      let nameSources: ContactNameSources = { displayName: chat.name, whatsappJid: chat.chatJid };

      const contact = chat.contactId ? await this.contactRepository.findById(chat.contactId) : null;
      if (contact) {
        nameSources = {
          verifiedName: contact.verifiedName,
          businessName: contact.businessName,
          displayName: contact.displayName ?? chat.name,
          pushName: contact.pushName,
          phoneNumber: contact.phoneNumber,
          whatsappJid: contact.whatsappJid,
        };
        phoneNumber = contact.phoneNumber;
        avatarMediaId = contact.profilePictureMediaId;
      }

      // A `@lid` chat identity carries no phone number of its own - resolved
      // (and persisted for next time) before displayName is computed, so a
      // freshly-found mapping actually reaches resolveDisplayName's phone
      // number tier instead of arriving too late to matter.
      if (chat.jidKind === 'lid' && !phoneNumber) {
        phoneNumber = await this.resolveAndPersistLidPhoneNumber(businessId, whatsappAccountId, chat.chatJid);
        if (phoneNumber) nameSources = { ...nameSources, phoneNumber };
      }

      const displayName = resolveDisplayName(nameSources);

      let lastMessagePreview: string | null = null;
      if (chat.lastMessageId) {
        const lastMessage = await this.messageRepository.findById(chat.lastMessageId);
        lastMessagePreview = lastMessage?.textContent ?? (lastMessage ? describeMessageType(lastMessage.messageType) : null);
      }

      summaries.push({
        id: chat.id,
        chatJid: chat.chatJid,
        chatType: chat.chatType,
        displayName,
        phoneNumber,
        unreadCount: chat.unreadCount,
        lastMessageAt: chat.lastMessageAt,
        lastMessagePreview,
        aiMode: chat.aiMode,
        hasActiveStatus: activeStatusCounts.has(chat.chatJid),
        activeStatusCount: activeStatusCounts.get(chat.chatJid) ?? 0,
        avatarMediaId,
      });
    }

    return summaries.sort((a, b) => {
      if (!a.lastMessageAt) return 1;
      if (!b.lastMessageAt) return -1;
      return b.lastMessageAt.localeCompare(a.lastMessageAt);
    });
  }

  async listCalls(businessId: string, whatsappAccountId: string): Promise<WorkspaceCallSummary[]> {
    const calls = await this.callRepository.listByAccount(businessId, whatsappAccountId);
    const summaries: WorkspaceCallSummary[] = [];

    for (const call of calls) {
      let displayName = call.remoteJid;
      let phoneNumber = call.remotePhoneNumber;

      const contact = await this.contactRepository.findByJid(businessId, whatsappAccountId, call.remoteJid);
      if (contact) {
        displayName = resolveDisplayName({
          verifiedName: contact.verifiedName,
          businessName: contact.businessName,
          displayName: contact.displayName,
          pushName: contact.pushName,
          phoneNumber: contact.phoneNumber,
          whatsappJid: contact.whatsappJid,
        });
        phoneNumber = phoneNumber ?? contact.phoneNumber;
      }

      if (classifyJid(call.remoteJid) === 'lid' && !phoneNumber) {
        const mapping = await this.jidMappingRepository.findByLid(businessId, whatsappAccountId, call.remoteJid);
        if (mapping?.phoneNumber) {
          phoneNumber = mapping.phoneNumber;
          if (displayName === call.remoteJid) displayName = mapping.phoneNumber;
        }
      }

      summaries.push({
        id: call.id,
        remoteJid: call.remoteJid,
        displayName,
        phoneNumber,
        callType: call.callType,
        direction: call.direction,
        status: call.status,
        isVideo: call.isVideo,
        isGroup: call.isGroup,
        startedAt: call.startedAt,
        endedAt: call.endedAt,
        durationSeconds: call.durationSeconds,
      });
    }

    return summaries;
  }

  async listStatuses(businessId: string, whatsappAccountId: string): Promise<WorkspaceStatusSummary[]> {
    const statuses = await this.statusRepository.listByAccount(businessId, whatsappAccountId);
    const mediaIds = statuses.map((status) => status.mediaId).filter((id): id is string => id !== null);
    const mediaRows = await this.mediaRepository.findByIds(mediaIds);
    const mediaById = new Map(mediaRows.map((row) => [row.id, row]));
    const summaries: WorkspaceStatusSummary[] = [];

    for (const status of statuses) {
      let displayName = status.publisherJid;

      const contact = await this.contactRepository.findByJid(businessId, whatsappAccountId, status.publisherJid);
      if (contact) {
        displayName = resolveDisplayName({
          verifiedName: contact.verifiedName,
          businessName: contact.businessName,
          displayName: contact.displayName,
          pushName: contact.pushName,
          phoneNumber: contact.phoneNumber,
          whatsappJid: contact.whatsappJid,
        });
      } else if (classifyJid(status.publisherJid) === 'lid') {
        const mapping = await this.jidMappingRepository.findByLid(businessId, whatsappAccountId, status.publisherJid);
        if (mapping?.phoneNumber) displayName = mapping.phoneNumber;
      }

      const mediaRow = status.mediaId ? mediaById.get(status.mediaId) : undefined;
      const media: WorkspaceMediaSummary | null = mediaRow
        ? {
            id: mediaRow.id,
            mediaType: mediaRow.mediaType,
            mimeType: mediaRow.mimeType,
            fileName: mediaRow.fileName,
            fileSize: mediaRow.fileSize,
            durationSeconds: mediaRow.durationSeconds,
            width: mediaRow.width,
            height: mediaRow.height,
            downloadStatus: mediaRow.downloadStatus,
          }
        : null;

      summaries.push({
        id: status.id,
        publisherJid: status.publisherJid,
        displayName,
        statusType: status.statusType,
        textContent: status.textContent,
        media,
        mediaAvailable: media?.downloadStatus === 'downloaded',
        createdAt: status.createdAt,
        expiresAt: status.expiresAt,
      });
    }

    return summaries;
  }

  private notFound(): ChatNotFoundError {
    const error = new Error('Chat not found for this business.') as ChatNotFoundError;
    error.code = 'CHAT_NOT_FOUND';
    return error;
  }

  /**
   * A `@lid` chat identity carries no phone number of its own. Checks the
   * real, already-persisted mapping first (whatsapp_jid_mappings, built from
   * contacts/history sync and every message's own alt-key fields); only
   * falls through to a live query against Baileys' own signal store
   * (which persists every LID<->phone pairing it has ever learned, even
   * for a LID that predates this account's connection) when the local
   * table genuinely has nothing yet. A live hit is persisted immediately,
   * so this is a one-time cost per LID, not a repeated live query.
   */
  private async resolveAndPersistLidPhoneNumber(
    businessId: string,
    whatsappAccountId: string,
    lidJid: string,
  ): Promise<string | null> {
    const localMapping = await this.jidMappingRepository.findByLid(businessId, whatsappAccountId, lidJid);
    if (localMapping?.phoneNumber) return localMapping.phoneNumber;

    const livePn = await whatsappConnectionService.resolvePhoneNumberForLid(lidJid);
    if (!livePn) return null;

    const phoneNumber = derivePhoneNumber(livePn, classifyJid(livePn), null);
    if (!phoneNumber) return null;

    await this.jidMappingRepository.upsert(businessId, whatsappAccountId, lidJid, livePn, phoneNumber, 'baileys_alt_jid', 'high');
    return phoneNumber;
  }

  async getChatDetail(businessId: string, whatsappAccountId: string, chatId: string) {
    const chat = await this.chatRepository.findById(chatId);
    if (!chat || chat.businessId !== businessId || chat.whatsappAccountId !== whatsappAccountId) {
      throw this.notFound();
    }

    const contact = chat.contactId ? await this.contactRepository.findById(chat.contactId) : null;
    const crmContact = contact
      ? await this.crmContactRepository.upsertForWhatsAppContact({ businessId, whatsappContactId: contact.id })
      : null;

    let resolvedPhoneNumber = contact?.phoneNumber ?? chat.phoneNumber ?? null;
    if (chat.jidKind === 'lid' && !resolvedPhoneNumber) {
      resolvedPhoneNumber = await this.resolveAndPersistLidPhoneNumber(businessId, whatsappAccountId, chat.chatJid);
    }

    // Presence is a per-JID concept - a group has no single "online" state, so this stays honestly null for groups.
    const presence =
      chat.chatType === 'individual'
        ? await this.presenceRepository.findLatest(businessId, whatsappAccountId, chat.chatJid)
        : null;

    return {
      chat,
      contact,
      crmContact,
      resolvedPhoneNumber,
      presence: presence ? { state: presence.presenceState, lastSeenAt: presence.lastSeenAt } : null,
    };
  }

  async listMessages(
    businessId: string,
    whatsappAccountId: string,
    chatId: string,
    limit = 50,
  ): Promise<WorkspaceMessageSummary[]> {
    const chat = await this.chatRepository.findById(chatId);
    if (!chat || chat.businessId !== businessId || chat.whatsappAccountId !== whatsappAccountId) {
      throw this.notFound();
    }
    const messages = await this.messageRepository.listByChat(chatId, limit);

    const mediaIds = messages.map((message) => message.mediaId).filter((id): id is string => id !== null);
    const mediaRows = await this.mediaRepository.findByIds(mediaIds);
    const mediaById = new Map(mediaRows.map((row) => [row.id, row]));

    const reactionRows = await this.reactionRepository.listByMessages(messages.map((message) => message.id));
    const reactionsByMessageId = new Map<string, WorkspaceReactionSummary[]>();
    for (const reaction of reactionRows) {
      const list = reactionsByMessageId.get(reaction.messageId) ?? [];
      list.push({ reactorJid: reaction.reactorJid, reaction: reaction.reaction });
      reactionsByMessageId.set(reaction.messageId, list);
    }

    // Only fromMe messages can possibly have been AI-sent - skip the query
    // entirely for a page of purely inbound messages.
    const fromMeIds = messages.filter((message) => message.fromMe).map((message) => message.id);
    const aiGeneratedIds = new Set(await this.outboundMessageRepository.listAiGeneratedMessageIds(fromMeIds));

    return messages.map((message) => {
      const mediaRow = message.mediaId ? mediaById.get(message.mediaId) : undefined;
      const media: WorkspaceMediaSummary | null = mediaRow
        ? {
            id: mediaRow.id,
            mediaType: mediaRow.mediaType,
            mimeType: mediaRow.mimeType,
            fileName: mediaRow.fileName,
            fileSize: mediaRow.fileSize,
            durationSeconds: mediaRow.durationSeconds,
            width: mediaRow.width,
            height: mediaRow.height,
            downloadStatus: mediaRow.downloadStatus,
          }
        : null;
      return {
        ...message,
        media,
        reactions: reactionsByMessageId.get(message.id) ?? [],
        aiGenerated: aiGeneratedIds.has(message.id),
      };
    });
  }

  async setAiMode(businessId: string, whatsappAccountId: string, chatId: string, aiMode: ChatAiMode) {
    const chat = await this.chatRepository.findById(chatId);
    if (!chat || chat.businessId !== businessId || chat.whatsappAccountId !== whatsappAccountId) {
      throw this.notFound();
    }
    return this.chatRepository.setAiMode(chatId, aiMode);
  }

  /**
   * A real reaction send over the live socket - not a locally-faked emoji
   * that only this app's UI shows. An empty emoji removes any existing
   * reaction (WhatsApp's own convention). The reaction row itself is never
   * written here: Baileys' own messages.reaction event fires for this send
   * exactly like it would for a reaction from the other side, and the
   * existing ingestion pipeline persists it from that one real event - so
   * this method's job ends at the send, not the bookkeeping.
   */
  async sendReaction(businessId: string, whatsappAccountId: string, messageId: string, emoji: string): Promise<void> {
    const message = await this.messageRepository.findById(messageId);
    if (!message || message.businessId !== businessId || message.whatsappAccountId !== whatsappAccountId) {
      throw this.notFound();
    }
    const chat = await this.chatRepository.findById(message.chatId);
    if (!chat) throw this.notFound();

    await whatsappConnectionService.sendReaction(
      {
        remoteJid: message.remoteJid,
        id: message.whatsappMessageId,
        fromMe: message.fromMe,
        participant: chat.chatType === 'group' ? message.senderJid : null,
      },
      emoji,
    );
  }

  /** The user actually opened and viewed this conversation - resets the real unread counter, never fabricates a "seen" state otherwise. */
  async markChatRead(businessId: string, whatsappAccountId: string, chatId: string) {
    const chat = await this.chatRepository.findById(chatId);
    if (!chat || chat.businessId !== businessId || chat.whatsappAccountId !== whatsappAccountId) {
      throw this.notFound();
    }
    return this.chatRepository.resetUnreadCount(chatId);
  }

  async listAgents(businessId: string) {
    return this.agentRepository.listByBusiness(businessId);
  }

  /**
   * Real plan-entitlement enforcement, not just a hidden UI button - a
   * business on a plan with max_ai_agents already reached (or no live
   * subscription at all) gets an honest denial, never a silently-created
   * agent past its limit.
   */
  async createAgent(businessId: string, input: CreateAgentInput) {
    const check = await this.entitlementService.canCreateAgent(businessId);
    if (!check.allowed) {
      const error = new Error(`Agent creation denied: ${check.reason}`) as EntitlementDeniedError;
      error.code = 'ENTITLEMENT_DENIED';
      error.reason = check.reason as EntitlementDenialReason;
      error.limit = check.limit;
      error.current = check.current;
      throw error;
    }
    return this.agentRepository.create({ businessId, ...input });
  }

  /**
   * The real, business-wide AI kill switch - a PAUSED agent is invisible to
   * findActiveForBusiness(), so the incoming-message worker silently skips
   * auto-reply for every chat in this business rather than sending anything,
   * without needing a separate "enabled" flag anywhere else.
   */
  async updateAgentStatus(businessId: string, agentId: string, status: AgentStatus): Promise<AiAgentRecord> {
    const agent = await this.agentRepository.findById(agentId);
    if (!agent || agent.businessId !== businessId || agent.deletedAt) {
      throw this.notFound();
    }
    await this.agentRepository.updateStatus(agentId, status);
    return { ...agent, status };
  }

  /**
   * Real aggregate counts over the trailing window, computed straight from
   * the same tables the rest of the workspace reads/writes - never a
   * separately maintained (and driftable) analytics rollup.
   */
  async getDashboardOverview(businessId: string, whatsappAccountId: string, periodDays = 30): Promise<WorkspaceDashboardOverview> {
    const sinceIso = new Date(Date.now() - periodDays * 24 * 60 * 60 * 1000).toISOString();

    const [messages, chats, calls, outboundReplies] = await Promise.all([
      this.messageRepository.countByDirectionSince(businessId, whatsappAccountId, sinceIso),
      this.chatRepository.countStatsSince(businessId, whatsappAccountId, sinceIso),
      this.callRepository.countByStatusSince(businessId, whatsappAccountId, sinceIso),
      this.outboundMessageRepository.countSentByRequesterSince(businessId, whatsappAccountId, sinceIso),
    ]);

    return { periodDays, messages, chats, calls, outboundReplies };
  }

  async getBusinessProfile(businessId: string): Promise<BusinessRecord> {
    const business = await this.businessRepository.findById(businessId);
    if (!business) throw new Error(`Business ${businessId} not found`);
    return business;
  }

  async updateBusinessName(businessId: string, name: string): Promise<BusinessRecord> {
    const updated = await this.businessRepository.updateName(businessId, name);
    if (!updated) throw new Error(`Business ${businessId} not found`);
    return updated;
  }

  /**
   * Real subscription/plan/usage state, not a fabricated billing dashboard.
   * `current` is only ever populated for entitlements that have a real,
   * counted backing source (agents, WhatsApp accounts) - an entitlement
   * like max_users has no user/auth system yet, so its usage stays null
   * rather than inventing a number.
   */
  async getBillingOverview(businessId: string): Promise<WorkspaceBillingOverview> {
    const subscription = await this.subscriptionRepository.findLiveByBusiness(businessId);
    if (!subscription) return { plan: null, subscription: null, entitlements: [] };

    const subscriptionSummary = {
      status: subscription.status,
      currentPeriodStart: subscription.currentPeriodStart,
      currentPeriodEnd: subscription.currentPeriodEnd,
      trialEndsAt: subscription.trialEndsAt,
      cancelledAt: subscription.cancelledAt,
    };

    const plan = await this.planRepository.findById(subscription.planId);
    if (!plan) return { plan: null, subscription: subscriptionSummary, entitlements: [] };

    const countByKey: Record<string, () => Promise<number>> = {
      max_ai_agents: () => this.agentRepository.countActiveByBusiness(businessId),
      max_whatsapp_accounts: () => this.accountRepository.countByBusiness(businessId),
    };

    const entitlementRows = await this.planRepository.listEntitlements(plan.id);
    const entitlements: WorkspaceBillingEntitlement[] = await Promise.all(
      entitlementRows.map(async (row) => ({
        key: row.entitlementKey,
        label: BILLING_ENTITLEMENT_LABELS[row.entitlementKey] ?? row.entitlementKey,
        isEnabled: row.isEnabled,
        limit: row.limitValue,
        current: countByKey[row.entitlementKey] ? await countByKey[row.entitlementKey]!() : null,
      })),
    );

    return {
      plan: { name: plan.name, planKey: plan.planKey, priceMonthlyCents: plan.priceMonthlyCents, currency: plan.currency },
      subscription: subscriptionSummary,
      entitlements,
    };
  }

  private crmContactNotFound(): CrmContactNotFoundError {
    const error = new Error('CRM contact not found for this business.') as CrmContactNotFoundError;
    error.code = 'CRM_CONTACT_NOT_FOUND';
    return error;
  }

  private leadNotFound(): LeadNotFoundError {
    const error = new Error('Lead not found for this business.') as LeadNotFoundError;
    error.code = 'LEAD_NOT_FOUND';
    return error;
  }

  private toCrmContactSummary(row: Awaited<ReturnType<CrmContactRepository['listByBusiness']>>[number]): WorkspaceCrmContactSummary {
    return {
      id: row.id,
      whatsappContactId: row.whatsappContactId,
      displayName: row.whatsappJid
        ? resolveDisplayName({
            verifiedName: row.contactVerifiedName,
            businessName: row.contactBusinessName,
            displayName: row.contactDisplayName,
            pushName: row.contactPushName,
            shortName: row.contactShortName,
            phoneNumber: row.phoneNumber,
            whatsappJid: row.whatsappJid,
          })
        : 'Unknown contact',
      phoneNumber: row.phoneNumber,
      source: row.source,
      stage: row.stage,
      leadStatus: row.leadStatus,
      tags: row.tags,
      notes: row.notes,
      updatedAt: row.updatedAt,
    };
  }

  async listCrmContacts(businessId: string): Promise<WorkspaceCrmContactSummary[]> {
    const rows = await this.crmContactRepository.listByBusiness(businessId);
    return rows.map((row) => this.toCrmContactSummary(row));
  }

  async updateCrmContact(
    businessId: string,
    crmContactId: string,
    input: UpdateCrmContactInput,
  ): Promise<WorkspaceCrmContactSummary> {
    const updated = await this.crmContactRepository.update(businessId, crmContactId, input);
    if (!updated) throw this.crmContactNotFound();
    // update() returns the plain record without the joined WhatsApp contact
    // info the summary display name needs - re-read it the same way the list does.
    const rows = await this.crmContactRepository.listByBusiness(businessId, 1000);
    const row = rows.find((r) => r.id === crmContactId);
    if (!row) throw this.crmContactNotFound();
    return this.toCrmContactSummary(row);
  }

  private toLeadSummary(row: Awaited<ReturnType<LeadRepository['listByBusiness']>>[number]): WorkspaceLeadSummary {
    return {
      id: row.id,
      crmContactId: row.crmContactId,
      displayName: row.whatsappJid
        ? resolveDisplayName({
            verifiedName: row.contactVerifiedName,
            businessName: row.contactBusinessName,
            displayName: row.contactDisplayName,
            pushName: row.contactPushName,
            shortName: row.contactShortName,
            phoneNumber: row.phoneNumber,
            whatsappJid: row.whatsappJid,
          })
        : 'Unknown contact',
      phoneNumber: row.phoneNumber,
      source: row.source,
      stage: row.stage,
      status: row.status,
      score: row.score,
      value: row.value,
      nextAction: row.nextAction,
      notes: row.notes,
      lastActivityAt: row.lastActivityAt,
      updatedAt: row.updatedAt,
    };
  }

  async listLeads(businessId: string): Promise<WorkspaceLeadSummary[]> {
    const rows = await this.leadRepository.listByBusiness(businessId);
    return rows.map((row) => this.toLeadSummary(row));
  }

  async createLead(businessId: string, input: CreateLeadInput) {
    const crmContact = await this.crmContactRepository.findByIdForBusiness(businessId, input.crmContactId);
    if (!crmContact) throw this.crmContactNotFound();
    return this.leadRepository.create({ businessId, ...input });
  }

  async updateLead(businessId: string, leadId: string, input: UpdateLeadInput): Promise<LeadRecord> {
    const updated = await this.leadRepository.update(businessId, leadId, input);
    if (!updated) throw this.leadNotFound();
    return updated;
  }

  async updateLeadStatus(businessId: string, leadId: string, status: LeadStatus): Promise<LeadRecord> {
    const updated = await this.leadRepository.updateStatusForBusiness(businessId, leadId, status);
    if (!updated) throw this.leadNotFound();
    return updated;
  }

  async getSyncStatus(whatsappAccountId: string) {
    const account = await this.accountRepository.findById(whatsappAccountId);
    if (!account) throw this.notFound();

    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM whatsapp_sync_jobs WHERE whatsapp_account_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [whatsappAccountId],
    );
    const latestJob = rows[0] ? await this.syncJobRepository.findById(rows[0].id) : null;

    return {
      syncStatus: account.syncStatus,
      syncProgress: account.syncProgress,
      syncStartedAt: account.syncStartedAt,
      syncCompletedAt: account.syncCompletedAt,
      lastSyncError: account.lastSyncError,
      latestJob,
    };
  }
}

export const workspaceService = new WorkspaceService();
