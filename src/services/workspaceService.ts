import { pool } from '../db/pool.js';
import { resolveDisplayName, type ContactNameSources } from '../domain/whatsapp/displayName.js';
import { WhatsAppAccountRepository } from '../repositories/whatsappAccountRepository.js';
import { BusinessRepository, isValidTimezone, type BusinessRecord } from '../repositories/businessRepository.js';
import { WhatsAppChatRepository, type ChatAiMode } from '../repositories/whatsappChatRepository.js';
import { WhatsAppContactRepository } from '../repositories/whatsappContactRepository.js';
import { WhatsAppMessageRepository } from '../repositories/whatsappMessageRepository.js';
import { WhatsAppSyncJobRepository } from '../repositories/whatsappSyncJobRepository.js';
import { CrmContactRepository, type UpdateCrmContactInput, type CrmContactWithContactInfo } from '../repositories/crmContactRepository.js';
import { CustomerMemoryRepository, emptyCustomerMemory } from '../repositories/customerMemoryRepository.js';
import { CustomerIdentityRepository } from '../repositories/customerIdentityRepository.js';
import type { ConversationFact, ConversationFunnelStage } from '../repositories/conversationStateRepository.js';
import { LeadRepository, type UpdateLeadInput, type LeadRecord, type LeadWithContactInfo } from '../repositories/leadRepository.js';
import { AiAgentRepository, type AiAgentRecord, type AgentCategory } from '../repositories/aiAgentRepository.js';
import { AgentTemplateRepository, type AgentTemplateRecord } from '../repositories/agentTemplateRepository.js';
import { AiCommitmentRepository, type AiCommitmentRecord } from '../repositories/aiCommitmentRepository.js';
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
import { whatsappConnectionManager } from './whatsappConnectionManager.js';
import { enqueueContactProfilePictureSync, storeAndAttachAccountProfilePicture } from './profilePictureSyncService.js';
import { notifyBusiness, notifyUser } from './notificationService.js';
import { BusinessMembershipRepository } from '../repositories/businessMembershipRepository.js';
import { TeamRepository } from '../repositories/teamRepository.js';
import { AgentCapacityRepository } from '../repositories/agentCapacityRepository.js';
import { SecurityAuditLogRepository, type SecurityAuditLogRecord } from '../repositories/securityAuditLogRepository.js';
import { PlatformActionRepository, type PlatformActionRow } from '../repositories/platformActionRepository.js';
import { PlatformAuditLedgerRepository, type AuditEventSearchFilters } from '../repositories/platformAuditLedgerRepository.js';
import type { AuditEvent } from '../domain/platform/contracts.js';
import { InvoiceRepository, type InvoiceRecord } from '../repositories/invoiceRepository.js';
import { ConversationStateRepository } from '../repositories/conversationStateRepository.js';
import { ScheduledMeetingsRepository, type ScheduledMeetingRecord } from '../repositories/scheduledMeetingsRepository.js';
import { AiUsageRepository } from '../repositories/aiUsageRepository.js';
import { CampaignRepository } from '../repositories/campaignRepository.js';
import { FunnelRepository } from '../repositories/funnelRepository.js';
import { KnowledgeBaseRepository } from '../repositories/knowledgeBaseRepository.js';
import { BusinessDocumentRepository } from '../repositories/businessDocumentRepository.js';
import { AgentWorkJournalRepository, type AgentWorkJournalEntryType } from '../repositories/agentWorkJournalRepository.js';
import * as googleMeetingOAuthService from './googleMeetingOAuthService.js';
import * as zoomMeetingOAuthService from './zoomMeetingOAuthService.js';
import * as emailOAuthService from './emailOAuthService.js';
import { getAiEngineStatus } from './aiEngineStatusService.js';
import { isProviderConfigured, isProviderEnabled, PAYMENT_PROVIDER_KINDS } from './billing/paymentProviderStatusService.js';
import type {
  CallStatus,
  CallType,
  MediaDownloadStatus,
  MediaType,
  MessageDirection,
  PresenceState,
} from '../domain/whatsapp/types.js';
import type { AgentStatus, LeadStatus, SubscriptionStatus } from '../domain/platform/types.js';

const HEX_COLOR_PATTERN = /^#[0-9A-Fa-f]{6}$/;
const LOGO_DATA_URL_PATTERN = /^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/]+=*)$/;
// A logo icon, not a photo - generous enough for a real crisp PNG/WebP mark, small enough to store inline on every businesses row read.
const MAX_LOGO_BYTES = 512 * 1024;

export interface WorkspaceChatSummary {
  id: string;
  chatJid: string;
  chatType: string;
  displayName: string;
  phoneNumber: string | null;
  unreadCount: number;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  /** The real persisted message type of the last message - drives the media icon in the list row, never guessed from the preview text. */
  lastMessageType: string | null;
  /** Real WhatsApp chat flags, synced from Baileys (chat.pinned / chat.archived). Null in the DB until a sync has actually reported them, surfaced as false. */
  isPinned: boolean;
  isArchived: boolean;
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
  /** Resolved sender display name for a group chat's inbound message - null for a DM (the chat itself already shows who it's with) and for any outbound message. */
  senderName: string | null;
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

export interface CapacityExceededError extends Error {
  code: 'CAPACITY_EXCEEDED';
  limit: number;
  current: number;
}

export function isCapacityExceededError(error: unknown): error is CapacityExceededError {
  return error instanceof Error && (error as CapacityExceededError).code === 'CAPACITY_EXCEEDED';
}

export interface InvalidAssignmentError extends Error {
  code: 'INVALID_ASSIGNMENT';
}

export function isInvalidAssignmentError(error: unknown): error is InvalidAssignmentError {
  return error instanceof Error && (error as InvalidAssignmentError).code === 'INVALID_ASSIGNMENT';
}

export interface WorkspaceCrmContactSummary {
  id: string;
  whatsappContactId: string | null;
  displayName: string;
  phoneNumber: string | null;
  /** Null until a person actually enters one - WhatsApp does not supply it. */
  email: string | null;
  source: string | null;
  stage: string | null;
  leadStatus: string | null;
  tags: string[];
  notes: string | null;
  updatedAt: string;
  isHidden: boolean;
  syncExcluded: boolean;
  aiExcluded: boolean;
  /**
   * Section 66: the real name-source breakdown identityEngine.ts's
   * resolveNameEvidence() already uses to personalize AI replies (see
   * aiContextGathererService.ts's contactNameSources) - previously computed
   * into a single collapsed displayName and then discarded, leaving staff
   * with no way to see which source AURA is actually drawing from, or that
   * "verified" (WhatsApp's own confirmed identity) and "push name"
   * (whatever the customer's phone happens to be set to) are different
   * things with very different trustworthiness.
   */
  verifiedName: string | null;
  businessName: string | null;
  pushName: string | null;
  shortName: string | null;
  /** Section 23: a staff member's manual correction/confirmation - the name actually shown above, when set. */
  manualDisplayName: string | null;
}

/** Section 13: the same cross-conversation facts customer_memory already feeds into every AI reply, made visible to staff. null customerId means no customer identity has been resolved for this contact yet (a group message, or a contact never linked to a customer). */
export interface WorkspaceCustomerMemory {
  customerId: string | null;
  confirmedFacts: ConversationFact[];
}

/** Section 75-91: a real data-subject-access export for one contact - see exportCrmContactData's own doc comment for scope. */
export interface WorkspaceCrmContactExport {
  contact: WorkspaceCrmContactSummary | null;
  email: string | null;
  stage: string | null;
  leadStatus: string | null;
  tags: string[];
  notes: string | null;
  customFields: Record<string, unknown>;
  customerMemory: ConversationFact[];
  conversationStates: { chatId: string; goal: string | null; confirmedFacts: ConversationFact[]; funnelStage: string | null; customerReadiness: string | null; updatedAt: string }[];
  exportedAt: string;
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

export interface WorkspacePlanCatalogueEntry {
  planKey: string;
  name: string;
  priceMonthlyCents: number;
  currency: string;
  isCurrent: boolean;
  entitlements: { key: string; label: string; isEnabled: boolean; limit: number | null }[];
}

export interface WorkspacePlanCatalogue {
  plans: WorkspacePlanCatalogueEntry[];
  /** False until a real payment provider exists - the UI must not offer an upgrade it cannot perform. */
  selfServeChangeAvailable: boolean;
  selfServeUnavailableReason?: string;
}

const BILLING_ENTITLEMENT_LABELS: Record<string, string> = {
  max_ai_agents: 'AI Agents',
  max_whatsapp_accounts: 'WhatsApp Accounts',
  max_users: 'Team Members',
  advanced_analytics: 'Advanced Analytics',
  max_active_campaigns: 'Active Campaigns',
  max_active_funnels: 'Active Funnels',
  max_knowledge_base_documents: 'Knowledge Base Documents',
  max_business_documents: 'Business Documents',
  max_ai_tokens_per_month: 'AI Tokens / Month',
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
  category?: AgentCategory | undefined;
  specialization?: string | null | undefined;
  triggerKeywords?: string[] | undefined;
  blockedKeywords?: string[] | undefined;
  protectedFacts?: string[] | undefined;
  blockedReplyMessage?: string | null | undefined;
  responseDelaySeconds?: number | undefined;
  parentAgentId?: string | null | undefined;
  escalateToAgentId?: string | null | undefined;
  priority?: number | undefined;
  autonomyLevel?: number | undefined;
  proactiveMode?: 'OFF' | 'ASSISTED' | 'DELEGATED' | 'AUTONOMOUS' | undefined;
  sourceTemplateKey?: string | null | undefined;
  sourceTemplateVersion?: number | null | undefined;
}

export interface ApprovalPatternSuggestion {
  agentId: string;
  agentName: string;
  approvedStreak: number;
}

export interface NextBestAction {
  id: string;
  type: 'chat_needs_human' | 'open_commitment' | 'pending_approval' | 'overdue_invoice' | 'approval_pattern_suggestion' | 'high_readiness_conversation';
  /**
   * Two tiers, deliberately - never a fabricated numeric priority/confidence
   * score. 'action_needed' is real, waiting, blocking work (a customer with
   * no reply, a broken promise, a decision an agent is blocked on, real
   * money overdue); 'suggestion' is a nice-to-have optimization, never
   * blocking anything. Within a tier, sorted oldest-first - the thing
   * that's been waiting longest is the most overdue for attention.
   */
  priority: 'action_needed' | 'suggestion';
  title: string;
  description: string;
  link: string;
  occurredAt: string;
}

/**
 * Section 48 (Autonomous Morning Briefing): "what did Aura do while I was
 * asleep" - built entirely from real, already-recorded rows (completed/
 * failed action requests, real audit events, real bookings, real leads),
 * never a generated narrative. `sinceIso` is caller-supplied (the frontend
 * defaults to a lookback window) rather than a fabricated "since you went
 * to sleep" precision this system has no real way to know.
 */
export interface MorningBriefing {
  sinceIso: string;
  completedActions: PlatformActionRow[];
  failedActions: PlatformActionRow[];
  pendingApprovals: PlatformActionRow[];
  riskFlags: SecurityAuditLogRecord[];
  chatsNeedingHuman: Array<{ id: string; displayName: string; updatedAt: string }>;
  newAppointments: ScheduledMeetingRecord[];
  newLeads: LeadWithContactInfo[];
  overdueInvoices: InvoiceRecord[];
  recommendedPriorities: NextBestAction[];
  /** Section 41-42 Phase 1: real counts from the autonomous sweep's own work journal since sinceIso - "While You Were Away", never a fabricated estimate. */
  autonomousActivity: Record<AgentWorkJournalEntryType, number>;
}

/**
 * Section 120 (Integration Health Centre): one real status per integration,
 * never a guess. Every field here is derived from something already
 * checked elsewhere in the codebase (env credential presence, a real
 * connection row, a live provider health check) - this method aggregates,
 * it never invents a new detection mechanism.
 */
export type IntegrationHealthState = 'connected' | 'not_connected' | 'not_configured' | 'degraded' | 'unavailable';
export interface IntegrationHealthEntry {
  id: string;
  label: string;
  category: 'meetings' | 'email' | 'messaging' | 'payments' | 'ai';
  state: IntegrationHealthState;
  detail: string | null;
}
export interface IntegrationHealth {
  integrations: IntegrationHealthEntry[];
}

const DEFAULT_APPROVAL_PATTERN_THRESHOLD = 10;
function getApprovalPatternThreshold(): number {
  const raw = Number(process.env.APPROVAL_PATTERN_THRESHOLD);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_APPROVAL_PATTERN_THRESHOLD;
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
  private readonly agentTemplateRepository = new AgentTemplateRepository(pool);
  private readonly commitmentRepository = new AiCommitmentRepository(pool);
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
  private readonly membershipRepository = new BusinessMembershipRepository(pool);
  private readonly teamRepository = new TeamRepository(pool);
  private readonly capacityRepository = new AgentCapacityRepository(pool);
  private readonly securityAuditLogRepository = new SecurityAuditLogRepository(pool);
  private readonly platformActionRepository = new PlatformActionRepository(pool);
  private readonly platformAuditLedgerRepository = new PlatformAuditLedgerRepository(pool);
  private readonly invoiceRepository = new InvoiceRepository(pool);
  private readonly conversationStateRepository = new ConversationStateRepository(pool);
  private readonly scheduledMeetingsRepository = new ScheduledMeetingsRepository(pool);
  private readonly aiUsageRepository = new AiUsageRepository(pool);
  private readonly customerMemoryRepository = new CustomerMemoryRepository(pool);
  private readonly customerIdentityRepository = new CustomerIdentityRepository(pool);
  private readonly campaignRepository = new CampaignRepository(pool);
  private readonly funnelRepository = new FunnelRepository(pool);
  private readonly knowledgeBaseRepository = new KnowledgeBaseRepository(pool);
  private readonly businessDocumentRepository = new BusinessDocumentRepository(pool);
  private readonly agentWorkJournalRepository = new AgentWorkJournalRepository(pool);

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

        // Best-effort, rate-limited background fetch so a real photo is
        // usually already there by the time a human opens this chat,
        // instead of only ever starting on that first click.
        if (!avatarMediaId) {
          enqueueContactProfilePictureSync(businessId, whatsappAccountId, contact.id, contact.whatsappJid);
        }
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
      let lastMessageType: string | null = null;
      if (chat.lastMessageId) {
        const lastMessage = await this.messageRepository.findByIdForBusiness(chat.lastMessageId, businessId);
        lastMessagePreview = lastMessage?.textContent ?? (lastMessage ? describeMessageType(lastMessage.messageType) : null);
        lastMessageType = lastMessage?.messageType ?? null;
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
        lastMessageType,
        isPinned: chat.isPinned ?? false,
        isArchived: chat.isArchived ?? false,
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

    const livePn = await whatsappConnectionManager.resolvePhoneNumberForLid(businessId, lidJid);
    if (!livePn) return null;

    const phoneNumber = derivePhoneNumber(livePn, classifyJid(livePn), null);
    if (!phoneNumber) return null;

    await this.jidMappingRepository.upsert(businessId, whatsappAccountId, lidJid, livePn, phoneNumber, 'baileys_alt_jid', 'high');
    return phoneNumber;
  }

  async getChatDetail(businessId: string, whatsappAccountId: string, chatId: string) {
    const chat = await this.chatRepository.findByIdForBusiness(chatId, businessId);
    if (!chat || chat.whatsappAccountId !== whatsappAccountId) {
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
    const chat = await this.chatRepository.findByIdForBusiness(chatId, businessId);
    if (!chat || chat.whatsappAccountId !== whatsappAccountId) {
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

    // A DM's sender is always "the chat" - already shown elsewhere in the
    // UI, and its own senderContactId points at the same contact whichever
    // message you look at - so this batch-fetch (and the whole point of a
    // per-message sender label) only matters for a group chat.
    const senderContactIds = chat.chatType === 'group'
      ? [...new Set(messages.map((message) => message.senderContactId).filter((id): id is string => id !== null))]
      : [];
    const senderContacts = await this.contactRepository.findByIds(senderContactIds);
    const senderNameByContactId = new Map(
      senderContacts.map((contact) => [
        contact.id,
        resolveDisplayName({
          verifiedName: contact.verifiedName,
          businessName: contact.businessName,
          displayName: contact.displayName,
          username: contact.username,
          pushName: contact.pushName,
          shortName: contact.shortName,
          phoneNumber: contact.phoneNumber,
          whatsappJid: contact.whatsappJid,
        }),
      ]),
    );

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
        senderName: message.senderContactId ? (senderNameByContactId.get(message.senderContactId) ?? null) : null,
      };
    });
  }

  async setAiMode(businessId: string, whatsappAccountId: string, chatId: string, aiMode: ChatAiMode) {
    const chat = await this.chatRepository.findByIdForBusiness(chatId, businessId);
    if (!chat || chat.whatsappAccountId !== whatsappAccountId) {
      throw this.notFound();
    }
    const updated = await this.chatRepository.setAiMode(chatId, aiMode, 'manual_toggle');

    // Real handoff notification - fires whenever a chat actually transitions
    // INTO human-takeover (never on a redundant re-set of the same mode),
    // regardless of whether a human flipped it manually or a future
    // automatic classifier (Chatwoot gap audit section 27) does it later.
    // Awaited (unlike the profile-picture sync elsewhere in this file,
    // which is a slow external network call) - this is a fast local insert,
    // and a caller reading notifications right after this call returns
    // should always see it.
    if (aiMode === 'HUMAN_TAKEOVER' && chat.aiMode !== 'HUMAN_TAKEOVER') {
      try {
        await notifyBusiness({
          businessId,
          type: 'HUMAN_HANDOFF',
          severity: 'critical',
          title: 'A conversation needs a human',
          body: chat.phoneNumber ? `WhatsApp conversation with +${chat.phoneNumber} needs your attention.` : 'A WhatsApp conversation needs your attention.',
          targetType: 'chat',
          targetId: chatId,
        });
      } catch (error) {
        console.error('[WorkspaceService] Failed to dispatch HUMAN_HANDOFF notification:', error);
      }
    }

    return updated;
  }

  /**
   * Real human-to-human conversation assignment - the axis separate from
   * ai_mode's AI-vs-human toggle. Enforces real agent capacity (never lets
   * a chat land on someone already at their configured limit) and
   * validates the target is an actual active member of this business, not
   * an arbitrary user id from another tenant.
   */
  async assignChat(
    businessId: string,
    whatsappAccountId: string,
    chatId: string,
    input: { assigneeUserId: string | null; assigneeTeamId: string | null },
  ) {
    const chat = await this.chatRepository.findByIdForBusiness(chatId, businessId);
    if (!chat || chat.whatsappAccountId !== whatsappAccountId) {
      throw this.notFound();
    }

    if (input.assigneeTeamId) {
      const team = await this.teamRepository.findByIdForBusiness(input.assigneeTeamId, businessId);
      if (!team) throw this.invalidAssignment();
    }

    if (input.assigneeUserId) {
      const membership = await this.membershipRepository.findByUserAndBusiness(input.assigneeUserId, businessId);
      if (!membership || membership.status !== 'active') throw this.invalidAssignment();

      // Reassigning a chat that's already theirs never counts against their limit.
      if (chat.assigneeUserId !== input.assigneeUserId) {
        const capacity = await this.capacityRepository.ensureDefault(businessId, input.assigneeUserId);
        const currentCount = await this.chatRepository.countAssignedToUser(businessId, input.assigneeUserId);
        if (currentCount >= capacity.maxActiveConversations) {
          throw this.capacityExceeded(capacity.maxActiveConversations, currentCount);
        }
      }
    }

    const updated = await this.chatRepository.setAssignment(chatId, input.assigneeUserId, input.assigneeTeamId);

    const assignmentChanged = chat.assigneeUserId !== input.assigneeUserId || chat.assigneeTeamId !== input.assigneeTeamId;
    if (assignmentChanged) {
      await this.securityAuditLogRepository.record({
        businessId,
        whatsappAccountId,
        eventType: 'chat_assigned',
        rawMetadata: { chatId, assigneeUserId: input.assigneeUserId, assigneeTeamId: input.assigneeTeamId },
      });
    }
    if (assignmentChanged && input.assigneeUserId) {
      try {
        await notifyUser(input.assigneeUserId, {
          businessId,
          type: 'ASSIGNMENT',
          severity: 'info',
          title: 'A conversation was assigned to you',
          body: chat.phoneNumber ? `WhatsApp conversation with +${chat.phoneNumber}.` : null,
          targetType: 'chat',
          targetId: chatId,
        });
      } catch (error) {
        console.error('[WorkspaceService] Failed to dispatch ASSIGNMENT notification:', error);
      }
    }

    return updated;
  }

  private capacityExceeded(limit: number, current: number): CapacityExceededError {
    const error = new Error(`Agent is already at capacity (${current}/${limit} active conversations).`) as CapacityExceededError;
    error.code = 'CAPACITY_EXCEEDED';
    error.limit = limit;
    error.current = current;
    return error;
  }

  private invalidAssignment(): InvalidAssignmentError {
    const error = new Error('Assignee is not a valid team or business member for this conversation.') as InvalidAssignmentError;
    error.code = 'INVALID_ASSIGNMENT';
    return error;
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
    const message = await this.messageRepository.findByIdForBusiness(messageId, businessId);
    if (!message || message.whatsappAccountId !== whatsappAccountId) {
      throw this.notFound();
    }
    const chat = await this.chatRepository.findByIdForBusiness(message.chatId, businessId);
    if (!chat) throw this.notFound();

    await whatsappConnectionManager.sendReaction(
      businessId,
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
    const chat = await this.chatRepository.findByIdForBusiness(chatId, businessId);
    if (!chat || chat.whatsappAccountId !== whatsappAccountId) {
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

  async listAgentTemplates(): Promise<AgentTemplateRecord[]> {
    return this.agentTemplateRepository.listAll();
  }

  /**
   * "Build My Agent" - creates a real agent pre-filled from a system
   * template, going through the exact same entitlement check and creation
   * path as manual creation (createAgent above). allowedToolsEnabled is
   * set true so the template's recommendedTools become a real, enforced
   * capability list (see buildReplyTools in aiReplyService.ts) - not just
   * a suggestion the agent ignores.
   */
  async createAgentFromTemplate(businessId: string, templateKey: string, nameOverride?: string): Promise<AiAgentRecord> {
    const template = await this.agentTemplateRepository.findByKey(templateKey);
    if (!template) throw this.notFound();

    const check = await this.entitlementService.canCreateAgent(businessId);
    if (!check.allowed) {
      const error = new Error(`Agent creation denied: ${check.reason}`) as EntitlementDeniedError;
      error.code = 'ENTITLEMENT_DENIED';
      error.reason = check.reason as EntitlementDenialReason;
      error.limit = check.limit;
      error.current = check.current;
      throw error;
    }

    return this.agentRepository.create({
      businessId,
      name: nameOverride?.trim() || template.name,
      description: template.description,
      persona: template.defaultPersona,
      tone: template.defaultTone,
      systemInstruction: template.defaultSystemInstruction,
      greeting: template.defaultGreeting,
      category: template.category,
      triggerKeywords: template.defaultTriggerKeywords,
      allowedTools: template.recommendedTools,
      allowedToolsEnabled: true,
      sourceTemplateKey: template.templateKey,
      sourceTemplateVersion: template.version,
    });
  }

  /**
   * A real full edit of an existing agent. Verifies the agent belongs to this
   * business before touching it, and validates that any parent/escalation
   * target is also this business's own agent - so hierarchy can never be
   * pointed at another tenant's agent, and an agent can never be made its own
   * parent.
   */
  async updateAgent(businessId: string, agentId: string, input: CreateAgentInput): Promise<AiAgentRecord> {
    const agent = await this.agentRepository.findByIdForBusiness(agentId, businessId);
    if (!agent || agent.deletedAt) throw this.notFound();

    for (const linkedId of [input.parentAgentId, input.escalateToAgentId]) {
      if (!linkedId) continue;
      if (linkedId === agentId) throw this.notFound();
      const linked = await this.agentRepository.findByIdForBusiness(linkedId, businessId);
      if (!linked || linked.deletedAt) throw this.notFound();
    }

    const updated = await this.agentRepository.update(agentId, input);
    if (!updated) throw this.notFound();

    await this.securityAuditLogRepository.record({
      businessId,
      eventType: 'agent_updated',
      rawMetadata: { agentId, category: updated.category },
    });

    return updated;
  }

  /**
   * Persists a real drag on the org canvas. Verifies ownership first, and
   * deliberately touches nothing but the coordinates - moving a tile must
   * never be able to alter routing behaviour.
   */
  async updateAgentPosition(businessId: string, agentId: string, x: number, y: number): Promise<void> {
    const agent = await this.agentRepository.findByIdForBusiness(agentId, businessId);
    if (!agent || agent.deletedAt) throw this.notFound();
    await this.agentRepository.updatePosition(agentId, x, y);
  }

  /**
   * The real, business-wide AI kill switch - a PAUSED agent is invisible to
   * findActiveForBusiness(), so the incoming-message worker silently skips
   * auto-reply for every chat in this business rather than sending anything,
   * without needing a separate "enabled" flag anywhere else.
   */
  async updateAgentStatus(businessId: string, agentId: string, status: AgentStatus): Promise<AiAgentRecord> {
    const agent = await this.agentRepository.findByIdForBusiness(agentId, businessId);
    if (!agent || agent.deletedAt) {
      throw this.notFound();
    }
    await this.agentRepository.updateStatus(agentId, status);
    return { ...agent, status };
  }

  /**
   * The narrow action a real approval-pattern suggestion acts on - flips
   * only autonomyLevel, the same way updateAgentStatus above flips only
   * status, without requiring the caller to round-trip the agent's entire
   * configuration through the full edit form.
   */
  async updateAgentAutonomyLevel(businessId: string, agentId: string, autonomyLevel: number): Promise<AiAgentRecord> {
    if (!Number.isInteger(autonomyLevel) || autonomyLevel < 1 || autonomyLevel > 5) {
      throw new Error('autonomyLevel must be an integer between 1 and 5');
    }
    const agent = await this.agentRepository.findByIdForBusiness(agentId, businessId);
    if (!agent || agent.deletedAt) {
      throw this.notFound();
    }
    await this.agentRepository.updateAutonomyLevel(agentId, autonomyLevel);
    return { ...agent, autonomyLevel };
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

  /**
   * Section 68 (Analytics): getDashboardOverview above has only ever
   * returned one collapsed period total - real enough, but useless for
   * "is this growing or shrinking," the actual question a trend chart
   * answers. Reuses the same real countByDirectionPerDay signal, capped
   * to a sane charting range (1-90 days) rather than trusting a caller-
   * supplied period directly into a query.
   */
  async getMessageVolumeTrend(businessId: string, whatsappAccountId: string, periodDays = 30): Promise<{ date: string; inbound: number; outbound: number }[]> {
    const clampedDays = Math.min(90, Math.max(1, Math.trunc(periodDays)));
    const sinceIso = new Date(Date.now() - clampedDays * 24 * 60 * 60 * 1000).toISOString();
    return this.messageRepository.countByDirectionPerDay(businessId, whatsappAccountId, sinceIso);
  }

  /** Section 68 (Analytics) follow-up: a real, live "where are all my conversations right now" funnel snapshot - see ConversationStateRepository.getFunnelStageCounts's own doc comment for why this is a snapshot, not a true funnel-over-time chart. */
  async getFunnelStageSnapshot(businessId: string): Promise<Record<ConversationFunnelStage, number>> {
    return this.conversationStateRepository.getFunnelStageCounts(businessId);
  }

  /** Section 34-40 (Token economy) follow-up: real per-agent token spend for the current calendar month - see AiUsageRepository.getMonthlyUsageByAgentForBusiness's own doc comment. Business-owner-facing, unlike getTopBusinessesByUsage/getPlatformTotal (developer control plane only). */
  async getAiUsageByAgent(businessId: string): Promise<{ agentId: string | null; agentName: string; totalTokens: number; callCount: number }[]> {
    return this.aiUsageRepository.getMonthlyUsageByAgentForBusiness(businessId);
  }

  /**
   * Real, unaddressed follow-up promises an AI reply made and nothing has
   * followed up on since (see AiCommitmentRepository.listOpen) - never a
   * guess at what "should" have happened, only chats where no later real
   * outbound message exists. olderThanHours defaults to 4 - long enough
   * that a same-conversation reply a few minutes later doesn't flag as
   * forgotten, short enough to still be useful same-day.
   */
  async getOpenCommitments(businessId: string, olderThanHours = 4): Promise<AiCommitmentRecord[]> {
    return this.commitmentRepository.listOpen(businessId, olderThanHours);
  }

  /**
   * Real "you've approved this N times, want it automatic?" detection -
   * built on the real approval history platform_action_requests/
   * platform_approvals already records (see ApprovalService), not a
   * fabricated confidence score. Only considers agents that currently
   * require approval (autonomyLevel 1 or 2) and have at least
   * `threshold` real, decided approvals on file - fewer than that is
   * never enough to call it a pattern. A single REJECTED anywhere in the
   * most recent `threshold` decisions breaks the streak entirely: this
   * is a strict "every single one so far" signal, not an average.
   */
  async getApprovalPatternSuggestions(businessId: string): Promise<ApprovalPatternSuggestion[]> {
    const threshold = getApprovalPatternThreshold();
    const agents = (await this.agentRepository.listByBusiness(businessId)).filter((agent) => agent.autonomyLevel <= 2);

    const decisionsByAgent = await this.platformActionRepository.getRecentDecisionsForAgents(businessId, agents.map((agent) => agent.id), threshold);

    const suggestions: ApprovalPatternSuggestion[] = [];
    for (const agent of agents) {
      const decisions = decisionsByAgent.get(agent.id) ?? [];
      if (decisions.length < threshold) continue;
      const allApproved = decisions.every((decision) => decision.status === 'APPROVED');
      if (!allApproved) continue;
      suggestions.push({ agentId: agent.id, agentName: agent.name, approvedStreak: decisions.length });
    }
    return suggestions;
  }

  /**
   * Real "Activity Log" - the searchable read side of the real, hash-chained
   * audit trail actionBusService.ts/propertyMaintenanceOrchestrator.ts
   * already write on every real action/approval (see
   * PlatformAuditLedgerRepository.search's own doc comment: this data
   * existed and accumulated with no way to read it back until now).
   */
  async getActivityLog(businessId: string, filters: AuditEventSearchFilters = {}): Promise<{ events: AuditEvent[]; nextCursor: number | null }> {
    return this.platformAuditLedgerRepository.search(businessId, filters);
  }

  /**
   * Real Next-Best-Action engine (Section 09 of the AURA master directive):
   * aggregates every real "this needs a decision" signal this codebase has
   * real data for - chats waiting on a human, unaddressed AI commitments,
   * pending approvals, overdue invoices, high-readiness/urgent
   * conversations the AI itself flagged (see conversation_states'
   * funnel_stage/customer_readiness, Sections 06/10) - plus the one real
   * "nice to have" signal (approval pattern suggestions), into one ranked
   * list. Ranking is two real, deterministic tiers (see
   * NextBestAction.priority's own doc comment), never a fabricated
   * AI-generated priority score - this is a real aggregation of existing
   * structured data, not a new judgment call.
   */
  async getNextBestActions(businessId: string, limit = 10): Promise<NextBestAction[]> {
    const [chatsNeedingHuman, commitments, pendingApprovals, overdueInvoices, approvalSuggestions, highReadinessChats] = await Promise.all([
      this.chatRepository.listNeedingHumanTakeover(businessId),
      this.commitmentRepository.listOpen(businessId, 4),
      this.platformActionRepository.listPendingApprovals(businessId),
      this.invoiceRepository.list(businessId, { status: 'OVERDUE' }),
      this.getApprovalPatternSuggestions(businessId),
      this.conversationStateRepository.listHighReadinessForBusiness(businessId),
    ]);

    const actions: NextBestAction[] = [
      ...chatsNeedingHuman.map((chat): NextBestAction => ({
        id: `chat:${chat.id}`,
        type: 'chat_needs_human',
        priority: 'action_needed',
        title: `Reply to ${chat.displayName}`,
        description: 'This conversation is waiting on a human reply.',
        link: `/chats/${chat.id}`,
        occurredAt: chat.updatedAt,
      })),
      ...commitments.map((commitment): NextBestAction => ({
        id: `commitment:${commitment.id}`,
        type: 'open_commitment',
        priority: 'action_needed',
        title: 'Follow up on a promise made',
        description: commitment.commitmentText,
        link: `/chats/${commitment.chatId}`,
        occurredAt: commitment.createdAt,
      })),
      ...pendingApprovals.map((action): NextBestAction => ({
        id: `approval:${action.id}`,
        type: 'pending_approval',
        priority: 'action_needed',
        title: `Approve or reject: ${action.type}`,
        description: 'An AI-proposed action is waiting for your decision.',
        link: '/property-operations',
        // PlatformActionRow types createdAt as Date, but db/pool.ts's global
        // TIMESTAMPTZ type parser actually returns a plain string at
        // runtime - the same pre-existing type/runtime mismatch flagged
        // elsewhere this session (see checkPropertyStatusTool.ts), worked
        // around the same way rather than fixed broadly here.
        occurredAt: action.createdAt as unknown as string,
      })),
      ...overdueInvoices.map((invoice): NextBestAction => ({
        id: `invoice:${invoice.id}`,
        type: 'overdue_invoice',
        priority: 'action_needed',
        title: `Overdue invoice ${invoice.invoiceNumber}`,
        description: `${(invoice.totalCents / 100).toFixed(2)} ${invoice.currencyCode} overdue${invoice.dueDate ? ` since ${invoice.dueDate}` : ''}.`,
        link: '/invoices',
        occurredAt: invoice.dueDate ?? invoice.createdAt,
      })),
      ...approvalSuggestions.map((suggestion): NextBestAction => ({
        id: `suggestion:${suggestion.agentId}`,
        type: 'approval_pattern_suggestion',
        priority: 'suggestion',
        title: `Consider automating ${suggestion.agentName}`,
        description: `${suggestion.approvedStreak} approvals in a row for this agent, none rejected.`,
        link: '/agents',
        occurredAt: new Date().toISOString(),
      })),
      ...highReadinessChats.map((chat): NextBestAction => ({
        id: `readiness:${chat.chatId}`,
        type: 'high_readiness_conversation',
        priority: 'action_needed',
        title: `${chat.displayName} looks ${chat.readiness === 'URGENT' ? 'urgent' : 'ready to act'}`,
        description: 'The AI assessed this customer as ready to move forward - a human check-in could help close it.',
        link: `/chats/${chat.chatId}`,
        occurredAt: chat.updatedAt,
      })),
    ];

    actions.sort((a, b) => {
      if (a.priority !== b.priority) return a.priority === 'action_needed' ? -1 : 1;
      return a.occurredAt.localeCompare(b.occurredAt);
    });

    return actions.slice(0, limit);
  }

  /**
   * Section 48 (Autonomous Morning Briefing): "what did Aura do while I was
   * asleep" - a real aggregation of already-recorded activity since
   * sinceIso, reusing the exact same real signal sources as
   * getNextBestActions/getApprovalPatternSuggestions above rather than a
   * second, parallel implementation. Nothing here is generated narrative;
   * every field is rows that already existed before this method ran.
   */
  async getMorningBriefing(businessId: string, sinceIso: string): Promise<MorningBriefing> {
    const [
      completedActions, failedActions, pendingApprovals, riskFlags,
      chatsNeedingHuman, newAppointments, newLeads, overdueInvoices, recommendedPriorities,
      autonomousActivity,
    ] = await Promise.all([
      this.platformActionRepository.listByStatusSince(businessId, ['SUCCEEDED'], sinceIso),
      this.platformActionRepository.listByStatusSince(businessId, ['FAILED'], sinceIso),
      this.platformActionRepository.listPendingApprovals(businessId),
      this.securityAuditLogRepository.listByTypeSince(businessId, 'message_risk_flagged', sinceIso),
      this.chatRepository.listNeedingHumanTakeover(businessId),
      this.scheduledMeetingsRepository.listCreatedSince(businessId, sinceIso),
      this.leadRepository.listCreatedSince(businessId, sinceIso),
      this.invoiceRepository.list(businessId, { status: 'OVERDUE' }),
      this.getNextBestActions(businessId),
      this.agentWorkJournalRepository.countByTypeSince(businessId, sinceIso),
    ]);

    return {
      sinceIso, completedActions, failedActions, pendingApprovals, riskFlags,
      chatsNeedingHuman, newAppointments, newLeads, overdueInvoices, recommendedPriorities,
      autonomousActivity,
    };
  }

  /**
   * Section 120 (Integration Health Centre): the single, real, honest
   * status of every integration this product has, in one place - closing
   * the gap Section 01's original audit flagged ("no central Integration
   * Health page surfacing this status uniformly"). Every entry is derived
   * from real, already-existing detection: server credential presence
   * (never a guess), a real per-business connection row where one exists,
   * and a live health check for AI providers (reusing the exact same
   * getAiEngineStatus() the AiEngineStrip on the dashboard already shows -
   * never a second, competing status source). Deliberately cheap: no new
   * live network probe is added here beyond what those existing checks
   * already do, matching the "Test" button pattern elsewhere in this
   * codebase where a live provider probe is always opt-in, not automatic.
   */
  async getIntegrationHealth(businessId: string): Promise<IntegrationHealth> {
    const [googleConnection, zoomConnection, emailAccounts, whatsappAccount, aiEngineStatus, paymentProviders] = await Promise.all([
      googleMeetingOAuthService.getConnection(businessId),
      zoomMeetingOAuthService.getConnection(businessId),
      emailOAuthService.listConnectedAccounts(businessId),
      this.accountRepository.findActiveByBusiness(businessId),
      getAiEngineStatus(),
      Promise.all(
        PAYMENT_PROVIDER_KINDS.map(async (kind) => ({ kind, configured: isProviderConfigured(kind), enabled: await isProviderEnabled(kind) })),
      ),
    ]);

    const integrations: IntegrationHealthEntry[] = [];

    integrations.push({
      id: 'google_meet', label: 'Google Meet', category: 'meetings',
      ...(!googleMeetingOAuthService.isConfigured()
        ? { state: 'not_configured' as const, detail: 'Server credentials (GMAIL_CLIENT_ID/SECRET) are not set.' }
        : googleConnection
          ? { state: 'connected' as const, detail: googleConnection.googleEmail }
          : { state: 'not_connected' as const, detail: null }),
    });

    integrations.push({
      id: 'zoom', label: 'Zoom', category: 'meetings',
      ...(!zoomMeetingOAuthService.isConfigured()
        ? { state: 'not_configured' as const, detail: 'Server credentials (ZOOM_CLIENT_ID/SECRET) are not set.' }
        : zoomConnection
          ? { state: 'connected' as const, detail: zoomConnection.zoomEmail }
          : { state: 'not_connected' as const, detail: null }),
    });

    for (const provider of ['gmail', 'outlook'] as const) {
      const account = emailAccounts.find((a) => a.provider === provider);
      integrations.push({
        id: `email_${provider}`, label: provider === 'gmail' ? 'Gmail' : 'Outlook', category: 'email',
        ...(!emailOAuthService.isConfigured(provider)
          ? { state: 'not_configured' as const, detail: `Server credentials (${provider === 'gmail' ? 'GMAIL' : 'OUTLOOK'}_CLIENT_ID/SECRET) are not set.` }
          : account
            ? { state: 'connected' as const, detail: account.emailAddress }
            : { state: 'not_connected' as const, detail: null }),
      });
    }

    integrations.push({
      id: 'whatsapp', label: 'WhatsApp', category: 'messaging',
      ...(!whatsappAccount
        ? { state: 'not_connected' as const, detail: null }
        : whatsappAccount.connectionStatus === 'CONNECTED'
          ? { state: 'connected' as const, detail: whatsappAccount.phoneNumber }
          : whatsappAccount.connectionStatus === 'LOGGED_OUT' || whatsappAccount.connectionStatus === 'CONFLICT_REPLACED'
            ? { state: 'not_connected' as const, detail: `Real status: ${whatsappAccount.connectionStatus}` }
            : { state: 'degraded' as const, detail: `Real status: ${whatsappAccount.connectionStatus}` }),
    });

    for (const engine of aiEngineStatus.engines) {
      const state: IntegrationHealthState =
        engine.state === 'configured' || engine.state === 'available' ? 'connected'
        : engine.state === 'not_configured' ? 'not_configured'
        : 'unavailable';
      integrations.push({ id: `ai_${engine.id}`, label: engine.label, category: 'ai', state, detail: engine.reason ?? null });
    }

    for (const { kind, configured, enabled } of paymentProviders) {
      integrations.push({
        id: `payment_${kind}`, label: kind.toUpperCase(), category: 'payments',
        ...(!configured
          ? { state: 'not_configured' as const, detail: null }
          : !enabled
            ? { state: 'degraded' as const, detail: 'Configured, but switched off from the Control Plane.' }
            : { state: 'connected' as const, detail: null }),
      });
    }

    return { integrations };
  }

  /**
   * Section 56 (Appointment System): every real meeting this business has
   * ever booked, across both providers - the first time this data has ever
   * been surfaced anywhere in the UI (previously only reachable per-chat,
   * via listByChat, with no business-wide view at all).
   */
  async listAppointments(businessId: string): Promise<ScheduledMeetingRecord[]> {
    return this.scheduledMeetingsRepository.listForBusiness(businessId);
  }

  /**
   * Section 56's lifecycle: a real human action, not automatic - cancels a
   * still-confirmed meeting. Does not attempt to also cancel the event on
   * the provider's own calendar (Google/Zoom) - that is a separate, real
   * integration surface this pass does not touch; this only updates our
   * own record of it. Returns null for anything not currently confirmed
   * (already cancelled/completed/etc.), which the caller reports as 404.
   */
  async cancelAppointment(businessId: string, id: string): Promise<ScheduledMeetingRecord | null> {
    return this.scheduledMeetingsRepository.markCancelled(businessId, id);
  }

  /** Only a human can know whether someone actually attended - never inferred. */
  async markAppointmentNoShow(businessId: string, id: string): Promise<ScheduledMeetingRecord | null> {
    return this.scheduledMeetingsRepository.markNoShow(businessId, id);
  }

  /**
   * Section 67 (CRM Data Export): every real CRM contact and lead this
   * business owns, capped generously (never truly "unlimited" - a runaway
   * query is a real operational risk) rather than paginated, since export
   * is inherently a "give me everything" request. Serialization to
   * CSV/JSON is the caller's concern (server/index.ts) - this method only
   * ever returns real, already-persisted rows.
   *
   * Section 75-91 (consent granularity): excludeSyncExcluded: true - a
   * contact staff have explicitly marked "Exclude from sync" must never
   * leave the system through this bulk export, the one real mechanism in
   * this codebase that hands a contact's structured PII to staff as a
   * portable file. See crmContactRepository.ts's listByBusiness doc
   * comment for why the everyday CRM list view and a single contact's own
   * deliberate export both leave this filter off.
   */
  async exportCrmData(businessId: string): Promise<{ contacts: CrmContactWithContactInfo[]; leads: LeadWithContactInfo[] }> {
    const CRM_EXPORT_LIMIT = 50_000;
    const [contacts, leads] = await Promise.all([
      this.crmContactRepository.listByBusiness(businessId, CRM_EXPORT_LIMIT, { excludeSyncExcluded: true }),
      this.leadRepository.listByBusiness(businessId, CRM_EXPORT_LIMIT, { excludeSyncExcluded: true }),
    ]);
    return { contacts, leads };
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
   * The AI reply pipeline needs a real timezone to know whether "now" is
   * inside the opening hours an operator wrote in free text - without one,
   * "now" defaults to UTC, which is silently wrong for almost every real
   * business.
   */
  async updateBusinessTimezone(businessId: string, timezone: string): Promise<BusinessRecord> {
    if (!isValidTimezone(timezone)) throw new Error(`INVALID: "${timezone}" is not a real IANA timezone name (e.g. "America/New_York").`);
    const updated = await this.businessRepository.updateTimezone(businessId, timezone);
    if (!updated) throw new Error(`Business ${businessId} not found`);
    return updated;
  }

  /**
   * `undefined` on a field leaves it untouched; `null` clears it back to the
   * app default. A logo is stored inline as a data: URI (see migration 941)
   * rather than through the encrypted WhatsApp media pipeline - it's small,
   * not customer PII, and needs to render instantly with no authenticated
   * fetch on either the dashboard or a generated invoice.
   */
  async updateBusinessBranding(
    businessId: string,
    patch: { brandColor?: string | null | undefined; logoDataUrl?: string | null | undefined },
  ): Promise<BusinessRecord> {
    let updated: BusinessRecord | null = null;

    if (patch.brandColor !== undefined) {
      if (patch.brandColor !== null && !HEX_COLOR_PATTERN.test(patch.brandColor)) {
        throw new Error('INVALID: brandColor must be a hex color like "#0a84ff"');
      }
      updated = await this.businessRepository.updateBrandColor(businessId, patch.brandColor);
      if (!updated) throw new Error(`Business ${businessId} not found`);
    }

    if (patch.logoDataUrl !== undefined) {
      if (patch.logoDataUrl !== null) {
        const match = LOGO_DATA_URL_PATTERN.exec(patch.logoDataUrl);
        if (!match) throw new Error('INVALID: logo must be a PNG, JPEG, or WebP image data URL');
        const decodedBytes = Buffer.from(match[1]!, 'base64').length;
        if (decodedBytes > MAX_LOGO_BYTES) throw new Error(`INVALID: logo image exceeds ${MAX_LOGO_BYTES / 1024}KB`);
      }
      updated = await this.businessRepository.updateLogo(businessId, patch.logoDataUrl);
      if (!updated) throw new Error(`Business ${businessId} not found`);
    }

    return updated ?? (await this.getBusinessProfile(businessId));
  }

  /**
   * Emergency "Stop All Agents" kill switch. The authoritative enforcement
   * is server-side in agentGuard.ts's guardToolInvocation - this setter
   * only flips the stored flag every tool call is checked against.
   */
  async setAiActionsPaused(businessId: string, paused: boolean): Promise<BusinessRecord> {
    const updated = await this.businessRepository.setAiActionsPaused(businessId, paused);
    if (!updated) throw new Error(`Business ${businessId} not found`);
    return updated;
  }

  /**
   * A real profile picture change - pushed to WhatsApp's own servers first
   * (updateOwnProfilePicture throws on failure, so a rejected upload never
   * gets stored locally as if it succeeded), then the exact same bytes are
   * kept as this account's local copy so the UI reflects it immediately
   * without waiting on a redundant CDN round-trip.
   */
  async updateAccountProfilePicture(businessId: string, whatsappAccountId: string, imageBuffer: Buffer, mimeType: string): Promise<void> {
    const account = await this.accountRepository.findById(whatsappAccountId);
    if (!account || account.businessId !== businessId) throw this.notFound();

    await whatsappConnectionManager.updateOwnProfilePicture(businessId, imageBuffer);
    await storeAndAttachAccountProfilePicture(businessId, whatsappAccountId, imageBuffer, mimeType);
  }

  /**
   * Real subscription/plan/usage state, not a fabricated billing dashboard.
   * `current` is only ever populated for entitlements that have a real,
   * counted backing source - every seeded entitlement key has one below.
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

    // Every count here mirrors the exact real source entitlementService
    // itself checks (same method, same repository) - previously only
    // max_ai_agents/max_whatsapp_accounts were wired up, so a business
    // could hit its campaign/funnel/document limit with zero warning on
    // its own billing page, only finding out from the create action's own
    // rejection.
    const countByKey: Record<string, () => Promise<number>> = {
      max_ai_agents: () => this.agentRepository.countActiveByBusiness(businessId),
      max_whatsapp_accounts: () => this.accountRepository.countByBusiness(businessId),
      max_active_campaigns: () => this.campaignRepository.countInFlightByBusiness(businessId),
      max_active_funnels: () => this.funnelRepository.countActiveByBusiness(businessId),
      max_knowledge_base_documents: () => this.knowledgeBaseRepository.countByBusiness(businessId),
      max_business_documents: () => this.businessDocumentRepository.countByBusiness(businessId),
      // Section 93-98: max_users had no count source here at all - the
      // billing page couldn't show a business its own seat usage, on top
      // of createMember() itself never having enforced the limit.
      max_users: () => this.membershipRepository.countForBusiness(businessId),
      // Section 34-40 (Token economy): the same monthly total
      // entitlementService.canUseAiThisMonth() checks before every real
      // Gemini call - a business can now see the number that will
      // eventually hand their conversations off to a human, not just find
      // out when it happens.
      max_ai_tokens_per_month: () => this.aiUsageRepository.getMonthlyTotalForBusiness(businessId),
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

  /**
   * The real plan catalogue, straight from the plans table with each plan's
   * real entitlement rows - so the comparison a customer sees is the same
   * data the EntitlementService actually enforces, never a marketing table
   * maintained separately and free to drift.
   */
  async getPlanCatalogue(businessId: string): Promise<WorkspacePlanCatalogue> {
    const subscription = await this.subscriptionRepository.findLiveByBusiness(businessId);
    const plans = await this.planRepository.listActive();

    const entries = await Promise.all(
      plans.map(async (plan) => {
        const entitlementRows = await this.planRepository.listEntitlements(plan.id);
        return {
          planKey: plan.planKey,
          name: plan.name,
          priceMonthlyCents: plan.priceMonthlyCents,
          currency: plan.currency,
          isCurrent: subscription?.planId === plan.id,
          entitlements: entitlementRows.map((row) => ({
            key: row.entitlementKey,
            label: BILLING_ENTITLEMENT_LABELS[row.entitlementKey] ?? row.entitlementKey,
            isEnabled: row.isEnabled,
            limit: row.limitValue,
          })),
        };
      }),
    );

    return {
      plans: entries,
      /*
       * No payment provider is wired up, so a plan genuinely cannot be
       * changed from this screen. The UI must say so rather than showing an
       * Upgrade button that silently does nothing.
       */
      selfServeChangeAvailable: false,
      selfServeUnavailableReason: 'No payment provider is connected yet, so plan changes are handled manually.',
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
            manualDisplayName: row.manualDisplayName,
            verifiedName: row.contactVerifiedName,
            businessName: row.contactBusinessName,
            displayName: row.contactDisplayName,
            pushName: row.contactPushName,
            shortName: row.contactShortName,
            phoneNumber: row.phoneNumber,
            whatsappJid: row.whatsappJid,
          })
        : row.manualDisplayName ?? 'Unknown contact',
      phoneNumber: row.phoneNumber,
      source: row.source,
      email: row.email,
      stage: row.stage,
      leadStatus: row.leadStatus,
      tags: row.tags,
      notes: row.notes,
      updatedAt: row.updatedAt,
      isHidden: row.isHidden,
      syncExcluded: row.syncExcluded,
      aiExcluded: row.aiExcluded,
      verifiedName: row.contactVerifiedName,
      businessName: row.contactBusinessName,
      pushName: row.contactPushName,
      shortName: row.contactShortName,
      manualDisplayName: row.manualDisplayName,
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

  /**
   * Section 13 (Conversational memory): customer_memory (migration 959)
   * has been real, written-through, and read back into every AI reply's
   * prompt since it was built - see aiReplyService.ts's "Known facts
   * about this customer from earlier conversations" line and
   * conversationStateWriter.ts's applyCustomerMemoryUpdate(). It was
   * never surfaced to a human anywhere, though - staff had no way to see
   * what the AI actually remembers about a returning customer across
   * their conversation history, the same gap Section 66 closed for
   * identity sources. Read-only: this mirrors what the AI already
   * resolves, never something staff edit directly here.
   */
  async getCrmContactMemory(businessId: string, crmContactId: string): Promise<WorkspaceCustomerMemory> {
    const crmContact = await this.crmContactRepository.findByIdForBusiness(businessId, crmContactId);
    if (!crmContact) throw this.crmContactNotFound();
    if (!crmContact.whatsappContactId) return { customerId: null, confirmedFacts: [] };

    const customerId = await this.customerIdentityRepository.findCustomerIdByIdentity(
      businessId,
      'whatsapp',
      'whatsapp_contact_id',
      crmContact.whatsappContactId,
    );
    if (!customerId) return { customerId: null, confirmedFacts: [] };

    const memory = (await this.customerMemoryRepository.find(businessId, customerId)) ?? emptyCustomerMemory(businessId, customerId);
    return { customerId, confirmedFacts: memory.confirmedFacts };
  }

  /**
   * Section 75-91 (data privacy - the real-access counterpart to
   * Section 72's real deletion): a genuine data-subject-access export
   * for one specific contact, not a bulk business dump - matches the
   * actual shape of a real privacy request ("what do you have on me?"),
   * scoped to the structured personal data this system actually holds:
   * the CRM profile, every automatic identity source, the cross-
   * conversation facts customer_memory records, and the per-conversation
   * facts/goal/funnel state conversation_states records for every real
   * chat this contact has ever had. Deliberately does not bundle raw
   * message history or media - a real, separate, much larger export
   * surface, not conjured as a side effect of this pass.
   */
  async exportCrmContactData(businessId: string, crmContactId: string): Promise<WorkspaceCrmContactExport> {
    const crmContact = await this.crmContactRepository.findByIdForBusiness(businessId, crmContactId);
    if (!crmContact) throw this.crmContactNotFound();

    const rows = await this.crmContactRepository.listByBusiness(businessId, 1000);
    const row = rows.find((r) => r.id === crmContactId);
    const summary = row ? this.toCrmContactSummary(row) : null;

    let customerMemory: ConversationFact[] = [];
    let conversationStates: { chatId: string; goal: string | null; confirmedFacts: ConversationFact[]; funnelStage: string | null; customerReadiness: string | null; updatedAt: string }[] = [];

    if (crmContact.whatsappContactId) {
      const customerId = await this.customerIdentityRepository.findCustomerIdByIdentity(
        businessId,
        'whatsapp',
        'whatsapp_contact_id',
        crmContact.whatsappContactId,
      );
      if (customerId) {
        const memory = await this.customerMemoryRepository.find(businessId, customerId);
        customerMemory = memory?.confirmedFacts ?? [];
      }

      const states = await this.conversationStateRepository.listByWhatsAppContact(businessId, crmContact.whatsappContactId);
      conversationStates = states.map((state) => ({
        chatId: state.chatId,
        goal: state.currentGoal?.description ?? null,
        confirmedFacts: state.confirmedFacts,
        funnelStage: state.funnelStage,
        customerReadiness: state.customerReadiness,
        updatedAt: state.updatedAt,
      }));
    }

    return {
      contact: summary,
      email: crmContact.email,
      stage: crmContact.stage,
      leadStatus: crmContact.leadStatus,
      tags: crmContact.tags,
      notes: crmContact.notes,
      customFields: crmContact.customFields,
      customerMemory,
      conversationStates,
      exportedAt: new Date().toISOString(),
    };
  }

  /**
   * Section 75-91 (single-subject erasure - the counterpart to
   * exportCrmContactData above): before this, the only way to erase a
   * customer's memory was accountDeletionService.ts's whole-business
   * purge - a business honoring one end-customer's "forget me" request had
   * no way to do that without deleting its entire WhatsApp account. Same
   * resolution and scope as the export above (customer_memory's cross-
   * conversation facts, conversation_states' per-conversation facts/goal/
   * funnel state) - deliberately leaves the CRM contact record itself
   * (name, email, notes, tags) untouched, since that is the business's own
   * record of the relationship, not AI-derived conversational memory.
   */
  async eraseCrmContactMemory(businessId: string, crmContactId: string): Promise<{ erasedCustomerMemory: boolean; erasedConversationStates: number }> {
    const crmContact = await this.crmContactRepository.findByIdForBusiness(businessId, crmContactId);
    if (!crmContact) throw this.crmContactNotFound();
    if (!crmContact.whatsappContactId) return { erasedCustomerMemory: false, erasedConversationStates: 0 };

    let erasedCustomerMemory = false;
    const customerId = await this.customerIdentityRepository.findCustomerIdByIdentity(
      businessId,
      'whatsapp',
      'whatsapp_contact_id',
      crmContact.whatsappContactId,
    );
    if (customerId) {
      erasedCustomerMemory = await this.customerMemoryRepository.deleteByCustomer(businessId, customerId);
    }

    const erasedConversationStates = await this.conversationStateRepository.deleteByWhatsAppContact(businessId, crmContact.whatsappContactId);

    await this.securityAuditLogRepository.record({
      businessId,
      eventType: 'crm_contact_memory_erased',
      rawMetadata: { crmContactId, erasedCustomerMemory, erasedConversationStates },
    });

    return { erasedCustomerMemory, erasedConversationStates };
  }

  private toLeadSummary(row: Awaited<ReturnType<LeadRepository['listByBusiness']>>[number]): WorkspaceLeadSummary {
    return {
      id: row.id,
      crmContactId: row.crmContactId,
      displayName: row.whatsappJid
        ? resolveDisplayName({
            manualDisplayName: row.contactManualDisplayName,
            verifiedName: row.contactVerifiedName,
            businessName: row.contactBusinessName,
            displayName: row.contactDisplayName,
            pushName: row.contactPushName,
            shortName: row.contactShortName,
            phoneNumber: row.phoneNumber,
            whatsappJid: row.whatsappJid,
          })
        : row.contactManualDisplayName ?? 'Unknown contact',
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
    const lead = await this.leadRepository.create({ businessId, ...input });

    try {
      await notifyBusiness({
        businessId,
        type: 'NEW_LEAD',
        severity: 'info',
        title: 'New lead created',
        body: input.source ? `Sourced from ${input.source}.` : null,
        targetType: 'lead',
        targetId: lead.id,
      });
    } catch (error) {
      console.error('[WorkspaceService] Failed to dispatch NEW_LEAD notification:', error);
    }

    return lead;
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

const _chatRepoForLogout = new WhatsAppChatRepository(pool);
const _auditRepoForLogout = new SecurityAuditLogRepository(pool);

/**
 * On logout, revert all HUMAN_TAKEOVER chats for the user's business back to
 * AI_ACTIVE so no chat is stranded without an AI agent after the agent leaves.
 */
export async function revertHumanTakeoverOnLogout(businessId: string): Promise<void> {
  const reverted = await _chatRepoForLogout.revertHumanTakeoverChats(businessId);
  if (reverted > 0) {
    console.log(`[WorkspaceService] Reverted ${reverted} HUMAN_TAKEOVER chat(s) to AI_ACTIVE on logout for business ${businessId}`);
    await _auditRepoForLogout.record({
      businessId,
      whatsappAccountId: null,
      eventType: 'handover_auto_reverted',
      rawMetadata: { revertedCount: reverted, trigger: 'logout' },
    }).catch((err: unknown) => console.error('[WorkspaceService] Failed to record handover_auto_reverted audit:', err));
  }
}
