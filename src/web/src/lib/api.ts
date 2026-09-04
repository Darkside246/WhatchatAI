export interface WhatsAppConnectionSnapshot {
  status: 'DISCONNECTED' | 'CONNECTING' | 'QR_READY' | 'PAIRING_CODE_READY' | 'CONNECTED' | 'RECONNECTING' | 'LOGGED_OUT' | 'CONFLICT_REPLACED' | 'ERROR';
  connected: boolean;
  qrAvailable: boolean;
  qrDataUrl: string | null;
  phoneNumber: string | null;
  jid: string | null;
  pushName: string | null;
  connectedAt: string | null;
  lastDisconnectAt: string | null;
  lastError: string | null;
  reconnectAttempt: number;
  /** When this exact code was produced. A real emission timestamp, not an expiry - WhatsApp never tells us the validity window. */
  qrGeneratedAt: string | null;
  /** This account's own real, downloaded profile picture media row - null until a sync has actually succeeded. */
  avatarMediaId: string | null;
  /** WhatsApp Web's own "Link with phone number instead" alternative to the QR code. Never auto-rotated by WhatsApp - pairingCodeGeneratedAt is an emission timestamp, not an expiry. */
  pairingCode: string | null;
  pairingCodeGeneratedAt: string | null;
  pairingPhoneNumber: string | null;
}

export interface SyncStatusResponse {
  syncStatus: 'not_started' | 'in_progress' | 'completed' | 'failed';
  syncProgress: number | null;
  syncStartedAt: string | null;
  syncCompletedAt: string | null;
  lastSyncError: string | null;
  latestJob: {
    chatsProcessed: number;
    contactsProcessed: number;
    groupsProcessed: number;
    messagesProcessed: number;
  } | null;
}

export interface WorkspaceChatSummary {
  id: string;
  chatJid: string;
  chatType: string;
  displayName: string;
  phoneNumber: string | null;
  unreadCount: number;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  /** Real persisted message type of the last message - drives the media icon, never guessed from preview text. */
  lastMessageType: string | null;
  /** Real WhatsApp chat flags synced from Baileys - false until a sync actually reports them. */
  isPinned: boolean;
  isArchived: boolean;
  aiMode: 'AI_ACTIVE' | 'AI_PAUSED' | 'HUMAN_TAKEOVER';
  /** A real, non-expired status exists for this chat's JID right now - WhatsApp's own "status ring" signal. */
  hasActiveStatus: boolean;
  /** The real count of active statuses for this JID - the ring divides into exactly this many segments, same as WhatsApp's own UI. */
  activeStatusCount: number;
  /** This contact's real, downloaded profile picture media row - null for groups and until a sync has actually succeeded. */
  avatarMediaId: string | null;
}

export interface WorkspaceMedia {
  id: string;
  mediaType: 'image' | 'video' | 'audio' | 'voice_note' | 'document' | 'sticker';
  mimeType: string | null;
  fileName: string | null;
  fileSize: number | null;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  downloadStatus: 'pending' | 'downloading' | 'downloaded' | 'failed' | 'unavailable' | 'retry_scheduled';
}

export interface WorkspaceReaction {
  reactorJid: string;
  reaction: string;
}

/** "Status comments" feature - a real WhatsApp reply to one published status. Never a public comment (WhatsApp Status has no such thing) - this is the private reply the poster's own business received, associated back to which status it replied to. */
export interface StatusReplyDto {
  id: string;
  chatId: string;
  senderJid: string;
  messageType: string;
  textContent: string | null;
  caption: string | null;
  timestamp: string;
}

export interface WorkspaceMessage {
  id: string;
  chatId: string;
  whatsappMessageId: string;
  senderJid: string;
  direction: 'inbound' | 'outbound';
  messageType: string;
  textContent: string | null;
  caption: string | null;
  timestamp: string;
  fromMe: boolean;
  isHistorical: boolean;
  status: 'pending' | 'sent' | 'delivered' | 'read' | 'played' | 'failed' | 'unknown';
  hasMedia: boolean;
  media: WorkspaceMedia | null;
  reactions: WorkspaceReaction[];
  /** True only when the AI reply pipeline sent this message - never inferred, read from the real dispatch record. */
  aiGenerated: boolean;
  /**
   * Real delete-for-everyone state. 'revoke_sent' means WhatsApp accepted the
   * instruction - it is NOT a guarantee every recipient's device dropped it,
   * and the UI must not word it as one.
   */
  revokeStatus: 'none' | 'requested' | 'revoke_sent' | 'failed';
  revokeSentAt: string | null;
  revokeError: string | null;
  /** Resolved sender display name for a group chat's inbound message - null for a DM and for any outbound message. */
  senderName: string | null;
}

export interface OutboundMessageDto {
  id: string;
  chatId: string;
  status: 'queued' | 'sending' | 'sent' | 'failed';
  messageType: 'text' | 'image' | 'video' | 'audio' | 'document';
}

export type SendMessageBody =
  | { messageType: 'text'; text: string; idempotencyKey?: string }
  | {
      /** 'voice_note' is a real WhatsApp PTT message; the server converts the recording to Ogg/Opus before sending. */
      messageType: 'image' | 'video' | 'audio' | 'voice_note' | 'document';
      mediaBase64: string;
      mediaMimeType: string;
      mediaFileName?: string;
      caption?: string;
      idempotencyKey?: string;
    };

/** Real, authenticated media URL - GET /api/media/:id (see server/index.ts) streams the decrypted bytes with Range support. */
export function mediaUrl(mediaId: string): string {
  return `/api/media/${mediaId}`;
}

export interface PlanEntitlement {
  id: string;
  planId: string;
  entitlementKey: string;
  /** null means unlimited for this plan. */
  limitValue: number | null;
  isEnabled: boolean;
}

export interface DeveloperPlan {
  id: string;
  planKey: string;
  name: string;
  description: string | null;
  priceMonthlyCents: number;
  priceYearlyCents: number | null;
  currency: string;
  isActive: boolean;
  entitlements: PlanEntitlement[];
}

export interface UpdatePlanBody {
  name?: string;
  description?: string | null;
  priceMonthlyCents?: number;
  priceYearlyCents?: number | null;
  isActive?: boolean;
}

export interface WorkspaceCrmContactSummary {
  id: string;
  whatsappContactId: string | null;
  displayName: string;
  phoneNumber: string | null;
  /** Null until someone enters one - WhatsApp does not provide an email address. */
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
  /** The real name sources AURA's AI actually draws from - see identityEngine.ts. Null when WhatsApp never supplied that particular field. */
  verifiedName: string | null;
  businessName: string | null;
  pushName: string | null;
  shortName: string | null;
  /** Section 23: a staff member's manual correction/confirmation - outranks every automatic source, including the customer's own self-reported preferred name. */
  manualDisplayName: string | null;
}

export interface UpdateCrmContactBody {
  stage: string | null;
  leadStatus: string | null;
  notes: string | null;
  tags: string[];
  /** Omit to keep the stored address; null clears it. */
  email?: string | null;
  /** Omit to keep the stored name override; null clears it, reverting to the next-best automatic source. */
  manualDisplayName?: string | null;
}

/** Section 13: the same cross-conversation facts the AI already draws on for this customer, made visible to staff. Read-only. */
export interface WorkspaceCustomerMemory {
  customerId: string | null;
  confirmedFacts: { key: string; value: string; origin: string; confirmedAt: string }[];
}

/** Section 75-91: a real data-subject-access export for one contact - the structured personal data this system holds on them, downloadable as JSON. */
export interface WorkspaceCrmContactExport {
  contact: WorkspaceCrmContactSummary | null;
  email: string | null;
  stage: string | null;
  leadStatus: string | null;
  tags: string[];
  notes: string | null;
  customFields: Record<string, unknown>;
  customerMemory: { key: string; value: string; origin: string; confirmedAt: string }[];
  conversationStates: { chatId: string; goal: string | null; confirmedFacts: { key: string; value: string; origin: string; confirmedAt: string }[]; funnelStage: string | null; customerReadiness: string | null; updatedAt: string }[];
  exportedAt: string;
}

export type LeadStatusValue = 'NEW' | 'QUALIFIED' | 'ENGAGED' | 'WON' | 'LOST';

export interface WorkspaceLeadSummary {
  id: string;
  crmContactId: string;
  displayName: string;
  phoneNumber: string | null;
  source: string | null;
  stage: string | null;
  status: LeadStatusValue;
  score: number | null;
  value: number | null;
  nextAction: string | null;
  notes: string | null;
  lastActivityAt: string | null;
  updatedAt: string;
}

export interface CreateLeadBody {
  crmContactId: string;
  source?: string;
  stage?: string;
  score?: number;
  value?: number;
  nextAction?: string;
  notes?: string;
}

export interface UpdateLeadBody {
  stage: string | null;
  score: number | null;
  value: number | null;
  nextAction: string | null;
  notes: string | null;
}

export interface WorkspaceDashboardOverview {
  periodDays: number;
  messages: { inbound: number; outbound: number };
  chats: { total: number; activeSince: number };
  calls: Partial<Record<WorkspaceCallSummary['status'], number>>;
  outboundReplies: { human: number; ai: number };
}

/** A real follow-up promise an AI reply made (detected deterministically, never a second AI call) that no later outbound message in that chat has addressed yet. */
export interface AiCommitmentRecord {
  id: string;
  businessId: string;
  chatId: string;
  commitmentText: string;
  detectedPhrase: string;
  createdAt: string;
}

/** A real "you've approved this N times, want it automatic?" suggestion - only ever surfaced once a real, unbroken streak of approvals meets the threshold, never a fabricated confidence score. */
export interface ApprovalPatternSuggestion {
  agentId: string;
  agentName: string;
  approvedStreak: number;
}

/** One real, hash-chained entry from platform_audit_events - every real action/approval this business's agents and operators have taken. */
export interface ActivityLogEvent {
  id: string;
  tenantId: string;
  eventType: string;
  actor: { kind: 'AGENT' | 'USER' | 'SYSTEM'; id: string };
  correlationId: string;
  actionRequestId?: string;
  payload: Record<string, unknown>;
  payloadHash: string;
  previousHash?: string;
  occurredAt: string;
  metadata?: Record<string, unknown>;
}

export interface ActivityLogFilters {
  eventType?: string;
  actorKind?: 'AGENT' | 'USER' | 'SYSTEM';
  occurredAfter?: string;
  occurredBefore?: string;
  beforeSequence?: number;
  limit?: number;
}

/** One real, ranked entry from the Next-Best-Action engine - see workspaceService.getNextBestActions's own doc comment for why priority is two real deterministic tiers, never a fabricated score. */
export interface NextBestAction {
  id: string;
  type: 'chat_needs_human' | 'open_commitment' | 'pending_approval' | 'overdue_invoice' | 'approval_pattern_suggestion' | 'high_readiness_conversation';
  priority: 'action_needed' | 'suggestion';
  title: string;
  description: string;
  link: string;
  occurredAt: string;
}

/** Section 56 (Appointment System) - a real meeting booked via Google Meet or Zoom, the first time this data has ever had a dedicated page. */
export interface AppointmentDto {
  id: string;
  chatId: string | null;
  contactId: string | null;
  provider: 'google_meet' | 'zoom';
  status: 'confirmed' | 'cancelled' | 'failed' | 'completed' | 'no_show';
  title: string;
  startAt: string;
  endAt: string;
  timezone: string;
  attendeeEmail: string | null;
  attendeeName: string | null;
  meetUrl: string;
  calendarHtmlLink: string | null;
  createdAt: string;
  cancelledAt: string | null;
}

/** Section 48 (Autonomous Morning Briefing) - see workspaceService.getMorningBriefing's own doc comment. Every field is real, already-recorded rows, never a generated narrative. */
export interface MorningBriefing {
  sinceIso: string;
  completedActions: Array<{ id: string; type: string; payload: Record<string, unknown>; createdAt: string; updatedAt: string }>;
  failedActions: Array<{ id: string; type: string; payload: Record<string, unknown>; executionError: string | null; createdAt: string; updatedAt: string }>;
  pendingApprovals: Array<{ id: string; type: string; riskLevel: string; createdAt: string }>;
  riskFlags: Array<{ id: string; reason: string | null; severity: string; createdAt: string; rawMetadata: Record<string, unknown> }>;
  chatsNeedingHuman: Array<{ id: string; displayName: string; updatedAt: string }>;
  newAppointments: Array<{ id: string; title: string; provider: string; startAt: string; attendeeEmail: string | null }>;
  newLeads: Array<{ id: string; stage: string | null; contactDisplayName: string | null; phoneNumber: string | null; createdAt: string }>;
  overdueInvoices: Array<{ id: string; invoiceNumber: string; totalCents: number; currencyCode: string; dueDate: string | null }>;
  recommendedPriorities: NextBestAction[];
  /** Section 41-42 Phase 1: real counts from the autonomous sweep's own work journal since sinceIso. */
  autonomousActivity: { FINDING: number; ACTION_TAKEN: number; QUEUED_FOR_APPROVAL: number; SKIPPED: number };
}

export interface WorkspaceBillingEntitlement {
  key: string;
  label: string;
  isEnabled: boolean;
  limit: number | null;
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
    status: 'ACTIVE' | 'TRIALING' | 'PAST_DUE' | 'PAUSED' | 'CANCELLED' | 'EXPIRED';
    currentPeriodStart: string | null;
    currentPeriodEnd: string | null;
    trialEndsAt: string | null;
    cancelledAt: string | null;
  } | null;
  entitlements: WorkspaceBillingEntitlement[];
}

export interface PlanCatalogueEntryDto {
  planKey: string;
  name: string;
  priceMonthlyCents: number;
  currency: string;
  isCurrent: boolean;
  entitlements: { key: string; label: string; isEnabled: boolean; limit: number | null }[];
}

export interface PlanCatalogueDto {
  plans: PlanCatalogueEntryDto[];
  /** False until a real payment provider exists. The UI must not offer an upgrade it cannot perform. */
  selfServeChangeAvailable: boolean;
  selfServeUnavailableReason?: string;
}

export interface WorkspaceBusiness {
  id: string;
  name: string;
  timezone: string;
  timeSource: 'AUTOMATIC' | 'MANUAL';
  manualOverrideTargetUtc: string | null;
  manualOverrideSetAt: string | null;
  productKey: string | null;
  isDeveloper: boolean;
  brandColor: string | null;
  logoDataUrl: string | null;
  /** Emergency "Stop All Agents" kill switch - true blocks every AI tool call above a plain read, enforced server-side regardless of this flag ever reaching the frontend. */
  aiActionsPaused: boolean;
  aiActionsPausedAt: string | null;
  /** Section 75-91: a real, pending account-deletion request (accountDeletionService.ts) - null unless the OWNER has explicitly requested it. */
  deletionRequestedAt: string | null;
  scheduledPurgeAt: string | null;
}

export type TimeSyncStatus = 'SYNCED' | 'DEGRADED' | 'STALE' | 'MANUAL_OVERRIDE';

export interface TimeContextDto {
  utcNow: string;
  timezone: string;
  localDateTime: string;
  localDate: string;
  dayOfWeek: string;
  utcOffset: string;
  syncStatus: TimeSyncStatus;
  lastSyncedAt: string | null;
  source: string;
}

export interface TimeStatusResponse {
  timeContext: TimeContextDto;
  sync: { status: 'SYNCED' | 'DEGRADED' | 'STALE'; provider: string; estimatedAccuracy: 'high' | 'degraded' | 'unknown' };
}

export const BUSINESS_ROLES = ['OWNER', 'ADMIN', 'MANAGER', 'SUPERVISOR', 'AGENT', 'MARKETING', 'VIEWER'] as const;
export type BusinessRole = (typeof BUSINESS_ROLES)[number];

export interface AuthUserDto {
  id: string;
  email: string;
  displayName: string;
  status: string;
}

export interface AuthMeResponse {
  user: AuthUserDto;
  business: WorkspaceBusiness;
  role: BusinessRole;
}

export interface BootstrapStatusResponse {
  registrationOpen: boolean;
}

export interface RegisterTrialResponse {
  user: AuthUserDto;
  productAccountId: string;
  productKey: string;
  trial: { id: string; startsAt: string; endsAt: string; state: string };
}

export interface AuthSessionDto {
  id: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  ipAddress: string | null;
  browser: string;
  os: string;
  /** The user's own label for this session (e.g. "My Laptop"), replacing "<browser> on <os>" once set - see sessionTokenService.ts's parseUserAgent for why the auto-generated label alone can't always tell two sessions apart. */
  deviceName: string | null;
  isCurrent: boolean;
}

export interface MemberDto {
  membershipId: string;
  userId: string;
  email: string;
  displayName: string;
  role: BusinessRole;
  status: string;
  joinedAt: string;
}

export type NotificationType =
  | 'HUMAN_HANDOFF'
  | 'NEW_MESSAGE'
  | 'NEW_LEAD'
  | 'MENTION'
  | 'ASSIGNMENT'
  | 'AI_FAILURE'
  | 'AUTOMATION_FAILURE'
  | 'SYNC_FAILURE'
  | 'PAYMENT_ISSUE'
  | 'CALL'
  | 'STATUS'
  | 'SLA_BREACH'
  | 'CAMPAIGN_FAILURE'
  | 'SYSTEM';

export interface TeamMemberDto {
  id: string;
  teamId: string;
  userId: string;
  email: string;
  displayName: string;
  createdAt: string;
}

export interface TeamDto {
  id: string;
  businessId: string;
  name: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
  members: TeamMemberDto[];
}

export type AgentAvailability = 'available' | 'busy' | 'offline';

export interface AgentCapacityDto {
  userId: string;
  businessId: string;
  maxActiveConversations: number;
  availability: AgentAvailability;
  createdAt: string;
  updatedAt: string;
}

export interface CapacitySummaryDto extends AgentCapacityDto {
  email: string;
  displayName: string;
  currentAssignedCount: number;
}

export const CAMPAIGN_STATUSES = ['DRAFT', 'REVIEW', 'APPROVED', 'SCHEDULED', 'RUNNING', 'COMPLETED', 'PAUSED', 'CANCELLED', 'FAILED'] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

export interface CampaignCounts {
  total: number;
  queued: number;
  sent: number;
  delivered: number;
  read: number;
  failed: number;
  cancelled: number;
}

export type CampaignMessageType = 'text' | 'image' | 'video' | 'document';

export interface CampaignDto {
  id: string;
  businessId: string;
  whatsappAccountId: string;
  createdBy: string;
  name: string;
  messageText: string;
  status: CampaignStatus;
  messageType: CampaignMessageType;
  mediaMimeType: string | null;
  mediaFileName: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  sentAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  counts: CampaignCounts;
}

export interface CampaignRecipientDto {
  id: string;
  campaignId: string;
  crmContactId: string;
  chatId: string;
  outboundMessageId: string | null;
  displayName: string;
  phoneNumber: string | null;
  status: 'queued' | 'sending' | 'sent' | 'delivered' | 'read' | 'played' | 'failed' | 'cancelled' | null;
  createdAt: string;
}

export interface CampaignDetailDto {
  campaign: Omit<CampaignDto, 'counts'>;
  recipients: CampaignRecipientDto[];
  counts: CampaignCounts;
}

export interface EligibleRecipientDto {
  crmContactId: string;
  chatId: string;
  displayName: string;
  phoneNumber: string | null;
}

export interface CreateCampaignResultDto {
  campaign: Omit<CampaignDto, 'counts'>;
  requestedCount: number;
  addedCount: number;
  skippedCrmContactIds: string[];
}

export const SCHEDULED_STATUS_STATES = ['DRAFT', 'SCHEDULED', 'PUBLISHING', 'PUBLISHED', 'FAILED', 'CANCELLED'] as const;
export type ScheduledStatusState = (typeof SCHEDULED_STATUS_STATES)[number];

/**
 * Which engine can actually answer right now. 'configured' deliberately
 * does NOT mean "proven working" - see aiEngineStatusService for why we
 * refuse to spend the operator's quota proving it on every page load.
 */
export interface AiEngineStatusDto {
  id: 'gemini' | 'goose';
  label: string;
  role: 'primary' | 'failover';
  state: 'configured' | 'available' | 'unavailable' | 'not_configured';
  checkedBy: 'configuration' | 'live_probe';
  reason?: string;
}

export interface AiEnginesDto {
  engines: AiEngineStatusDto[];
  canGenerate: boolean;
}

export type GeminiTestResultDto = { status: 'ok'; detail: string } | { status: 'failed'; reason: string };

export const EMAIL_KINDS = ['custom', 'order_update', 'appointment', 'receipt', 'invoice', 'general_update'] as const;
export type EmailKind = (typeof EMAIL_KINDS)[number];
export type EmailStatus = 'draft' | 'approved' | 'sending' | 'sent' | 'failed' | 'cancelled' | 'indeterminate';

export interface EmailMessageDto {
  id: string;
  kind: EmailKind;
  toEmail: string;
  toName: string | null;
  subject: string;
  bodyText: string;
  status: EmailStatus;
  createdBy: string | null;
  /** Set when an AI agent wrote the draft. A person still has to approve it. */
  draftedByAgentId: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  sentAt: string | null;
  provider: string | null;
  providerMessageId: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EmailCapabilitiesDto {
  providerConfigured: boolean;
  senderConfigured: boolean;
  provider: string;
  /** Whether the credential in effect came from Settings or the server environment. */
  credentialSource: 'workspace' | 'environment' | 'none';
  reason?: string;
}

export type EmailProviderKind = 'resend' | 'smtp';

/** Secrets are never returned - only whether one is stored. */
export interface EmailSettingsDto {
  provider: EmailProviderKind;
  fromEmail: string;
  fromName: string | null;
  replyToEmail: string | null;
  resendApiKeySet: boolean;
  smtpHost: string | null;
  smtpPort: number | null;
  smtpSecure: boolean;
  smtpUsername: string | null;
  smtpPasswordSet: boolean;
  lastTestAt: string | null;
  lastTestOk: boolean | null;
  lastTestError: string | null;
}

export interface ScheduledStatusDto {
  id: string;
  businessId: string;
  whatsappAccountId: string;
  createdBy: string;
  statusType: 'text' | 'image' | 'video';
  textContent: string | null;
  caption: string | null;
  backgroundColor: string | null;
  mediaStorageReference: string | null;
  mediaMimeType: string | null;
  scheduledAt: string;
  status: ScheduledStatusState;
  publishedAt: string | null;
  lastError: string | null;
  /** NULL means we hold no WhatsApp key for this post, so it genuinely cannot be recalled. */
  publishedWhatsappMessageId: string | null;
  revokeStatus: 'none' | 'requested' | 'revoke_sent' | 'failed';
  revokeSentAt: string | null;
  revokeError: string | null;
  createdAt: string;
  updatedAt: string;
}

export const FUNNEL_NODE_TYPES = [
  'MESSAGE',
  'WAIT',
  'CONDITION',
  'ASSIGN_HUMAN',
  'ASSIGN_TEAM',
  'SEND_EMAIL',
  'ADD_TAG',
  'REMOVE_TAG',
  'UPDATE_STAGE',
  'NOTIFY_USER',
] as const;
export type FunnelNodeType = (typeof FUNNEL_NODE_TYPES)[number];

export interface FunnelStepDto {
  id: string;
  funnelId: string;
  position: number;
  nodeType: FunnelNodeType;
  config: Record<string, unknown>;
  createdAt: string;
}

export interface FunnelInstanceDto {
  id: string;
  funnelId: string;
  businessId: string;
  crmContactId: string;
  chatId: string;
  currentPosition: number;
  status: 'ACTIVE' | 'WAITING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
  startedAt: string;
  completedAt: string | null;
  lastError: string | null;
  updatedAt: string;
}

export interface FunnelCounts {
  entered: number;
  active: number;
  completed: number;
  failed: number;
  cancelled: number;
}

export interface FunnelDto {
  id: string;
  businessId: string;
  whatsappAccountId: string;
  createdBy: string;
  name: string;
  description: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  stepCount: number;
  counts: FunnelCounts;
}

export interface FunnelDetailDto {
  funnel: Omit<FunnelDto, 'stepCount' | 'counts'>;
  steps: FunnelStepDto[];
  instances: FunnelInstanceDto[];
  counts: FunnelCounts;
}

export interface KnowledgeBaseDocumentDto {
  id: string;
  businessId: string;
  createdBy: string;
  title: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}

export interface BusinessDocumentDto {
  id: string;
  businessId: string;
  createdBy: string;
  filename: string;
  currentVersionId: string | null;
  status: string;
  aiRetrievable: boolean;
  aiSendable: boolean;
  customerVisible: boolean;
  humanOnly: boolean;
  createdAt: string;
  updatedAt: string;
}

export type PromptOptimizationStatus = 'pending_review' | 'approved' | 'rejected';

/**
 * The Node-side record of a DSPy prompt optimization run - see
 * services/prompt-optimizer/ (a separate, offline Python tool) for how one
 * of these actually gets produced. Importing one never changes what the
 * live agent says; only `approve` does, and only an authenticated operator
 * with the `ai.edit` permission can call it.
 */
export interface PromptOptimizationDto {
  id: string;
  businessId: string;
  agentId: string;
  source: 'dspy';
  status: PromptOptimizationStatus;
  baselineInstruction: string | null;
  optimizedInstruction: string;
  metricName: string | null;
  metricScore: number | null;
  datasetSummary: Record<string, unknown>;
  createdAt: string;
  reviewedBy: string | null;
  reviewedAt: string | null;
  rejectionReason: string | null;
}

export interface MarketingCopySuggestionResult {
  status: 'ok' | 'unavailable';
  reason?: string;
  suggestions: string[];
}

export interface NotificationDto {
  id: string;
  type: NotificationType;
  severity: 'info' | 'warning' | 'critical';
  title: string;
  body: string | null;
  targetType: string | null;
  targetId: string | null;
  createdAt: string;
  readAt: string | null;
  dismissedAt: string | null;
}

export const AGENT_CATEGORIES = [
  'general', 'sales', 'support', 'billing', 'bookings', 'logistics',
  'plumbing', 'electrical', 'mechanical', 'hvac', 'construction',
  'cleaning', 'landscaping', 'it_services', 'beauty', 'hospitality',
] as const;
export type AgentCategory = (typeof AGENT_CATEGORIES)[number];

/**
 * Trades where the agent is hard-limited to business operations and barred
 * from giving technical or safety advice. Mirrors the backend list in
 * aiAgentRepository - shown in the UI so the operator can see the limit is
 * real and enforced server-side, not just a label.
 */
export const ADVICE_RESTRICTED_CATEGORIES: readonly AgentCategory[] = [
  'plumbing', 'electrical', 'mechanical', 'hvac', 'construction', 'it_services',
];

export interface AiAgentSummary {
  id: string;
  name: string;
  status: 'ACTIVE' | 'PAUSED' | 'ARCHIVED';
  description: string | null;
  persona: string | null;
  tone: string | null;
  language: string | null;
  systemInstruction: string | null;
  greeting: string | null;
  businessContext: string | null;
  responseStyle: string | null;
  humanTakeoverPolicy: string | null;
  category: AgentCategory;
  specialization: string | null;
  triggerKeywords: string[];
  blockedKeywords: string[];
  /** Real facts that must never appear in an AI-generated reply - enforced automatically, not just a prompt instruction. */
  protectedFacts: string[];
  /** Sent to the customer when a reply is blocked. Null means the app's built-in default message is used. */
  blockedReplyMessage: string | null;
  responseDelaySeconds: number;
  parentAgentId: string | null;
  escalateToAgentId: string | null;
  priority: number;
  /** Real operator-chosen canvas coordinates. Null until they actually place it. */
  canvasX: number | null;
  canvasY: number | null;
  /** The only tools this agent may call, when allowedToolsEnabled is true - a real, enforced restriction (see buildReplyTools in aiReplyService.ts), not a suggestion. */
  allowedTools: string[];
  /** Always enforced regardless of allowedToolsEnabled - a real hard block. */
  forbiddenTools: string[];
  allowedToolsEnabled: boolean;
  /** The real 5-level autonomy ladder: 1 read-only, 2 manual (SEND-tier needs approval), 3 balanced (default), 4 trusted (executes + notifies), 5 fully autonomous. */
  autonomyLevel: number;
  /** Section 41-42 Phase 1: a separate axis from autonomyLevel - whether this agent's business gets swept for unprompted work at all. OFF by default; nothing opts in silently. */
  proactiveMode: 'OFF' | 'ASSISTED' | 'DELEGATED' | 'AUTONOMOUS';
  /** Which system template (and version of it) this agent was created from, if any - null for a manual or custom-description agent. */
  sourceTemplateKey: string | null;
  sourceTemplateVersion: number | null;
}

/** A real, system-owned starter template for the "Build My Agent" guided setup flow - see agent_templates (migration 951). */
export interface AgentTemplate {
  id: string;
  templateKey: string;
  name: string;
  role: string;
  description: string;
  category: AgentCategory;
  defaultPersona: string | null;
  defaultTone: string | null;
  defaultSystemInstruction: string;
  defaultGreeting: string | null;
  defaultTriggerKeywords: string[];
  /** Real tool names from the backend's tool registry - never a capability that isn't actually implemented. */
  recommendedTools: string[];
  /** Bumped whenever the system template's own content changes - compared against an agent's sourceTemplateVersion to know honestly whether it's fallen behind. */
  version: number;
}

/** The real structured shape a free-text agent description gets converted into - never persisted until the user activates it. */
export interface ParsedAgentConfig {
  name: string;
  role: string;
  description: string;
  persona: string;
  tone: string;
  systemInstruction: string;
  greeting: string;
  category: AgentCategory;
  triggerKeywords: string[];
  /** Filtered to only real, registered tool names server-side - never a fabricated capability. */
  recommendedTools: string[];
}

export interface RoutingPreviewResult {
  outcome: 'route' | 'escalate_to_human' | 'no_agent';
  reason: string;
  agentId: string | null;
  matchedKeyword: string | null;
}

export interface ProtectedFactsTestResult {
  allowed: boolean;
  eventType: 'ai_output_leak_blocked' | 'ai_output_leak_check_unavailable' | 'ai_output_leak_pass';
  reason: string | null;
}

export interface CreateAgentBody {
  name: string;
  description?: string | null;
  persona?: string | null;
  tone?: string | null;
  language?: string | null;
  systemInstruction?: string | null;
  greeting?: string | null;
  businessContext?: string | null;
  responseStyle?: string | null;
  humanTakeoverPolicy?: string | null;
  category?: AgentCategory;
  specialization?: string | null;
  triggerKeywords?: string[];
  blockedKeywords?: string[];
  protectedFacts?: string[];
  blockedReplyMessage?: string | null;
  responseDelaySeconds?: number;
  parentAgentId?: string | null;
  escalateToAgentId?: string | null;
  priority?: number;
  allowedTools?: string[];
  forbiddenTools?: string[];
  allowedToolsEnabled?: boolean;
  autonomyLevel?: number;
  proactiveMode?: AiAgentSummary['proactiveMode'];
  sourceTemplateKey?: string | null;
  sourceTemplateVersion?: number | null;
}

export interface WorkspaceContact {
  id: string;
  whatsappJid: string;
  phoneNumber: string | null;
  displayName: string | null;
  pushName: string | null;
  aboutText: string | null;
  /** This contact's real, downloaded profile picture media row - null until a sync has actually succeeded. */
  profilePictureMediaId: string | null;
}

export interface WorkspaceCrmContact {
  id: string;
  stage: string | null;
  leadStatus: string | null;
  tags: string[];
  notes: string | null;
}

export interface WorkspaceChatDetailRecord {
  id: string;
  chatJid: string;
  chatType: string;
  name: string | null;
  phoneNumber: string | null;
  aiMode: WorkspaceChatSummary['aiMode'];
  assigneeUserId: string | null;
  assigneeTeamId: string | null;
}

export interface WorkspacePresence {
  state: 'available' | 'unavailable' | 'composing' | 'recording' | 'paused' | 'unknown';
  lastSeenAt: string | null;
}

export interface WorkspaceChatDetail {
  chat: WorkspaceChatDetailRecord;
  contact: WorkspaceContact | null;
  crmContact: WorkspaceCrmContact | null;
  /** For a `@lid` identity, the real phone number resolved from Baileys' own lid<->phone mapping, when known. */
  resolvedPhoneNumber: string | null;
  /** Null for group chats (no single "online" state) or when no presence.update event has ever arrived for this contact. */
  presence: WorkspacePresence | null;
}

export interface WorkspaceStatus {
  id: string;
  publisherJid: string;
  displayName: string;
  statusType: 'text' | 'image' | 'video' | 'audio' | 'unknown';
  textContent: string | null;
  media: WorkspaceMedia | null;
  mediaAvailable: boolean;
  createdAt: string;
  expiresAt: string | null;
}

export interface UserPreferencesDto {
  userId: string;
  country: string | null;
  navigationOrder: string[] | null;
  timezone: string;
  language: string;
  theme: string;
  density: 'comfortable' | 'compact';
  chatFontSize: 'small' | 'medium' | 'large';
}

export interface Argon2ParamsDto {
  memoryCostKib: number;
  timeCost: number;
  parallelism: number;
  hashLengthBytes: number;
}

export interface LockStatusResponse {
  configured: boolean;
}

export interface UnlockChallengeResponse {
  salt: string;
  argon2Params: Argon2ParamsDto;
}

export interface UnlockResultResponse {
  unlocked: boolean;
  revoked: boolean;
  remainingAttempts: number | null;
}

export interface HumanTakeoverAlertDto {
  chatId: string;
  lineLabel: string;
  urgency: 'HIGH' | 'MEDIUM' | 'LOW';
  triggeredAt: string;
  customerName: string | null;
  customerPhoneNumber: string | null;
}

export interface WorkspaceCallSummary {
  id: string;
  remoteJid: string;
  displayName: string;
  phoneNumber: string | null;
  callType: 'voice' | 'video' | 'unknown';
  direction: 'inbound' | 'outbound';
  status: 'offer' | 'ringing' | 'accepted' | 'rejected' | 'missed' | 'timeout' | 'ended' | 'unknown';
  isVideo: boolean;
  isGroup: boolean;
  startedAt: string | null;
  endedAt: string | null;
  durationSeconds: number | null;
}

export interface ReplySuggestionResult {
  status: 'ok' | 'unavailable';
  reason?: string;
  suggestions: string[];
}

export interface GlobalSearchResult {
  type: 'chat' | 'contact' | 'lead' | 'campaign' | 'funnel';
  id: string;
  title: string;
  subtitle: string | null;
  url: string;
}

class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    ...init,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new ApiError(response.status, body.error ?? 'UNKNOWN_ERROR', body.message ?? response.statusText);
  }
  return body as T;
}

export { ApiError };

/**
 * Section 67 (CRM Data Export): triggers a real browser download of every
 * real contact/lead this business owns - a real file, not a preview.
 * Bypasses request() above since the response is a file, not JSON.
 */
export async function downloadCrmExport(format: 'csv' | 'json' = 'csv'): Promise<void> {
  const response = await fetch(`/api/workspace/crm/export?format=${format}`, { credentials: 'same-origin' });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new ApiError(response.status, body.error ?? 'EXPORT_FAILED', body.message ?? response.statusText);
  }
  const disposition = response.headers.get('content-disposition') ?? '';
  const filenameMatch = /filename="([^"]+)"/.exec(disposition);
  const filename = filenameMatch?.[1] ?? `crm-export.${format}`;
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export type InvoiceDto = {
  id: string;
  businessId: string;
  contactId: string | null;
  propertyId: string | null;
  documentType: 'INVOICE' | 'QUOTE' | 'RECEIPT';
  status: 'DRAFT' | 'PENDING_APPROVAL' | 'APPROVED' | 'SENT' | 'PAID' | 'OVERDUE' | 'CANCELLED' | 'VOID';
  invoiceNumber: string;
  currencyCode: string;
  subtotalCents: number;
  taxBasisPoints: number;
  discountCents: number;
  totalCents: number;
  dueDate: string | null;
  notes: string | null;
  terms: string | null;
  footerText: string | null;
  aiGenerated: boolean;
  approvedAt: string | null;
  sentAt: string | null;
  paidAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type InvoiceLineItemDto = {
  id: string;
  invoiceId: string;
  sortOrder: number;
  description: string;
  quantity: string;
  unitPriceCents: number;
  discountBasisPoints: number;
  totalCents: number;
};

export type CreateInvoiceInput = {
  contactId?: string;
  propertyId?: string;
  documentType?: 'INVOICE' | 'QUOTE' | 'RECEIPT';
  currencyCode?: string;
  taxBasisPoints?: number;
  dueDate?: string;
  notes?: string;
  terms?: string;
  footerText?: string;
  lineItems: Array<{
    description: string;
    quantity: number;
    unitPriceCents: number;
    discountBasisPoints?: number;
    sortOrder?: number;
  }>;
};

export const api = {
  getWhatsAppStatus: () => request<WhatsAppConnectionSnapshot>('/whatsapp/status'),
  connectWhatsApp: () => request<WhatsAppConnectionSnapshot>('/whatsapp/connect', { method: 'POST' }),
  pairWhatsAppByPhone: (phoneNumber: string) =>
    request<WhatsAppConnectionSnapshot>('/whatsapp/pair-by-phone', { method: 'POST', body: JSON.stringify({ phoneNumber }) }),
  disconnectWhatsApp: () => request<WhatsAppConnectionSnapshot>('/whatsapp/disconnect', { method: 'POST' }),
  logoutWhatsApp: () => request<WhatsAppConnectionSnapshot>('/whatsapp/logout', { method: 'POST' }),
  getSyncStatus: () => request<SyncStatusResponse>('/workspace/sync-status'),
  listChats: () => request<{ chats: WorkspaceChatSummary[] }>('/workspace/chats'),
  getChatDetail: (chatId: string) => request<WorkspaceChatDetail>(`/workspace/chats/${chatId}`),
  listMessages: (chatId: string) => request<{ messages: WorkspaceMessage[] }>(`/workspace/chats/${chatId}/messages`),
  sendMessage: (chatId: string, body: SendMessageBody) =>
    request<{ outboundMessage: OutboundMessageDto }>(`/workspace/chats/${chatId}/messages`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  // The send endpoint returns 202 the instant a send is queued, not once it
  // actually succeeds or fails (dispatch is async) - this is how a caller
  // finds out the real outcome.
  getOutboundMessage: (id: string) =>
    request<{ id: string; status: OutboundMessageDto['status']; lastError: string | null }>(
      `/workspace/outbound-messages/${id}`,
    ),
  setAiMode: (chatId: string, aiMode: WorkspaceChatSummary['aiMode']) =>
    request(`/workspace/chats/${chatId}/ai-mode`, { method: 'PATCH', body: JSON.stringify({ aiMode }) }),
  markChatRead: (chatId: string) => request(`/workspace/chats/${chatId}/read`, { method: 'POST' }),
  /** Empty emoji removes any existing reaction - WhatsApp's own convention. */
  sendReaction: (messageId: string, emoji: string) =>
    request(`/workspace/messages/${messageId}/reactions`, { method: 'POST', body: JSON.stringify({ emoji }) }),
  /** Only valid on media in the 'failed' state - the real outcome (success/failed/unavailable) arrives later via the 'media.updated' realtime event. */
  retryMediaDownload: (mediaId: string) =>
    request<{ media: WorkspaceMedia }>(`/workspace/media/${mediaId}/retry`, { method: 'POST' }),
  getBilling: () => request<WorkspaceBillingOverview>('/workspace/billing'),
  /** Section 34-40 follow-up: real per-agent AI token spend for this calendar month - never guessed, no rate estimate. */
  getAiUsageByAgent: () => request<{ usage: { agentId: string | null; agentName: string; totalTokens: number; callCount: number }[] }>('/workspace/billing/ai-usage-by-agent'),
  getPlanCatalogue: () => request<PlanCatalogueDto>('/workspace/billing/plans'),
  getDashboard: () => request<WorkspaceDashboardOverview>('/workspace/dashboard'),
  /** Section 68: the same real inbound/outbound message signal getDashboard already aggregates, broken out per day for a real trend chart. */
  getMessageVolumeTrend: (days = 30) =>
    request<{ trend: { date: string; inbound: number; outbound: number }[] }>(`/workspace/dashboard/message-volume?days=${days}`),
  /** Section 68 follow-up: a live count of real conversations in each funnel_stage right now - a snapshot, not a history-over-time chart (conversation_states overwrites its own funnel_stage, it doesn't log transitions). */
  getFunnelSnapshot: () => request<{ stages: Record<string, number> }>('/workspace/dashboard/funnel-snapshot'),
  getOpenCommitments: () => request<{ commitments: AiCommitmentRecord[] }>('/workspace/commitments/open'),
  getApprovalPatternSuggestions: () => request<{ suggestions: ApprovalPatternSuggestion[] }>('/workspace/agents/approval-suggestions'),
  getNextBestActions: () => request<{ actions: NextBestAction[] }>('/workspace/next-best-actions'),
  getMorningBriefing: (sinceHours?: number) =>
    request<MorningBriefing>(`/workspace/morning-briefing${sinceHours ? `?sinceHours=${sinceHours}` : ''}`),
  listAppointments: () => request<{ appointments: AppointmentDto[] }>('/workspace/appointments'),
  cancelAppointment: (id: string) => request<{ appointment: AppointmentDto }>(`/workspace/appointments/${id}/cancel`, { method: 'POST' }),
  markAppointmentNoShow: (id: string) => request<{ appointment: AppointmentDto }>(`/workspace/appointments/${id}/no-show`, { method: 'POST' }),
  getActivityLog: (filters: ActivityLogFilters = {}) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) {
      if (value !== undefined && value !== '') params.set(key, String(value));
    }
    const query = params.toString();
    return request<{ events: ActivityLogEvent[]; nextCursor: number | null }>(`/workspace/activity-log${query ? `?${query}` : ''}`);
  },
  getBusiness: () => request<{ business: WorkspaceBusiness }>('/workspace/business'),
  updateBusiness: (name: string) =>
    request<{ business: WorkspaceBusiness }>('/workspace/business', { method: 'PATCH', body: JSON.stringify({ name }) }),
  updateBusinessTimezone: (timezone: string) =>
    request<{ business: WorkspaceBusiness }>('/workspace/business/timezone', {
      method: 'PATCH',
      body: JSON.stringify({ timezone }),
    }),
  /** Either field may be omitted (leave untouched) or sent as `null` (clear back to the app default). */
  updateBusinessBranding: (patch: { brandColor?: string | null; logoDataUrl?: string | null }) =>
    request<{ business: WorkspaceBusiness }>('/workspace/business/branding', {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  setAiActionsPaused: (paused: boolean) =>
    request<{ business: WorkspaceBusiness }>('/workspace/business/ai-pause', {
      method: 'PATCH',
      body: JSON.stringify({ paused }),
    }),
  getTimeStatus: () => request<TimeStatusResponse>('/workspace/time-status'),
  /** `targetLocalDateTime` is a "YYYY-MM-DDTHH:mm" wall-clock string (no timezone suffix) - interpreted server-side against the business's own timezone. */
  enableManualTimeOverride: (targetLocalDateTime: string) =>
    request<{ business: WorkspaceBusiness }>('/workspace/business/time-override', {
      method: 'PATCH',
      body: JSON.stringify({ enabled: true, targetLocalDateTime }),
    }),
  disableManualTimeOverride: () =>
    request<{ business: WorkspaceBusiness }>('/workspace/business/time-override', {
      method: 'PATCH',
      body: JSON.stringify({ enabled: false }),
    }),
  /** Pushes a real profile picture to WhatsApp itself (Baileys updateProfilePicture) - never just a local-only avatar swap. */
  updateAccountProfilePicture: (imageBase64: string, mimeType: string) =>
    request<{ status: string }>('/workspace/account/profile-picture', {
      method: 'PUT',
      body: JSON.stringify({ imageBase64, mimeType }),
    }),
  listAgents: () => request<{ agents: AiAgentSummary[] }>('/workspace/agents'),
  listAgentTemplates: () => request<{ templates: AgentTemplate[] }>('/workspace/agent-templates'),
  createAgentFromTemplate: (templateKey: string, name?: string) =>
    request<{ agent: AiAgentSummary }>('/workspace/agents/from-template', { method: 'POST', body: JSON.stringify({ templateKey, name }) }),
  parseAgentDescription: (description: string) =>
    request<{ config: ParsedAgentConfig }>('/workspace/agents/parse-description', { method: 'POST', body: JSON.stringify({ description }) }),
  createAgent: (body: CreateAgentBody) =>
    request<{ agent: AiAgentSummary }>('/workspace/agents', { method: 'POST', body: JSON.stringify(body) }),
  updateAgent: (id: string, body: CreateAgentBody) =>
    request<{ agent: AiAgentSummary }>(`/workspace/agents/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  updateAgentPosition: (id: string, x: number, y: number) =>
    request<void>(`/workspace/agents/${id}/position`, { method: 'PATCH', body: JSON.stringify({ x, y }) }),
  previewAgentRouting: (text: string) =>
    request<RoutingPreviewResult>('/workspace/agents/routing-preview', { method: 'POST', body: JSON.stringify({ text }) }),
  /** Tests a (possibly unsaved) draft Protected Facts list against a sample reply - never persists anything. */
  testProtectedFacts: (protectedFacts: string[], sampleReply: string) =>
    request<ProtectedFactsTestResult>('/workspace/agents/protected-facts/test', {
      method: 'POST',
      body: JSON.stringify({ protectedFacts, sampleReply }),
    }),
  updateAgentAutonomyLevel: (id: string, autonomyLevel: number) =>
    request<{ agent: AiAgentSummary }>(`/workspace/agents/${id}/autonomy-level`, {
      method: 'PATCH',
      body: JSON.stringify({ autonomyLevel }),
    }),
  updateAgentStatus: (id: string, status: AiAgentSummary['status']) =>
    request<{ agent: AiAgentSummary }>(`/workspace/agents/${id}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    }),
  listPromptOptimizations: (agentId: string) =>
    request<{ optimizations: PromptOptimizationDto[] }>(`/workspace/agents/${agentId}/prompt-optimizations`),
  importPromptOptimization: (
    agentId: string,
    body: { optimizedInstruction: string; metricName?: string | null; metricScore?: number | null; datasetSummary?: Record<string, unknown> },
  ) =>
    request<{ optimization: PromptOptimizationDto }>(`/workspace/agents/${agentId}/prompt-optimizations`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  approvePromptOptimization: (agentId: string, optimizationId: string) =>
    request<{ optimization: PromptOptimizationDto }>(`/workspace/agents/${agentId}/prompt-optimizations/${optimizationId}/approve`, {
      method: 'POST',
    }),
  rejectPromptOptimization: (agentId: string, optimizationId: string, reason?: string | null) =>
    request<{ optimization: PromptOptimizationDto }>(`/workspace/agents/${agentId}/prompt-optimizations/${optimizationId}/reject`, {
      method: 'POST',
      body: JSON.stringify({ reason: reason ?? null }),
    }),
  listCrmContacts: () => request<{ crmContacts: WorkspaceCrmContactSummary[] }>('/workspace/crm-contacts'),
  updateCrmContact: (id: string, body: UpdateCrmContactBody) =>
    request<{ crmContact: WorkspaceCrmContactSummary }>(`/workspace/crm-contacts/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  setCrmContactPrivacyFlags: (id: string, flags: { isHidden?: boolean; syncExcluded?: boolean; aiExcluded?: boolean }) =>
    request<{ crmContact: Record<string, unknown> }>(`/workspace/crm-contacts/${id}/privacy`, {
      method: 'PATCH',
      body: JSON.stringify(flags),
    }),
  getCrmContactMemory: (id: string) => request<{ memory: WorkspaceCustomerMemory }>(`/workspace/crm-contacts/${id}/memory`),
  exportCrmContactData: (id: string) => request<WorkspaceCrmContactExport>(`/workspace/crm-contacts/${id}/export`),
  /** Section 75-91: the erasure counterpart to the export above - permanently deletes this contact's cross-conversation and per-conversation AI memory, never the CRM contact record itself. */
  eraseCrmContactMemory: (id: string) =>
    request<{ erasedCustomerMemory: boolean; erasedConversationStates: number }>(`/workspace/crm-contacts/${id}/memory`, { method: 'DELETE' }),
  listLeads: () => request<{ leads: WorkspaceLeadSummary[] }>('/workspace/leads'),
  createLead: (body: CreateLeadBody) =>
    request<{ lead: WorkspaceLeadSummary }>('/workspace/leads', { method: 'POST', body: JSON.stringify(body) }),
  updateLead: (id: string, body: UpdateLeadBody) =>
    request<{ lead: WorkspaceLeadSummary }>(`/workspace/leads/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  updateLeadStatus: (id: string, status: LeadStatusValue) =>
    request<{ lead: WorkspaceLeadSummary }>(`/workspace/leads/${id}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    }),
  listCalls: () => request<{ calls: WorkspaceCallSummary[] }>('/workspace/calls'),
  listStatuses: () => request<{ statuses: WorkspaceStatus[] }>('/workspace/statuses'),
  getLockStatus: () => request<LockStatusResponse>('/security/lock/status'),
  getUnlockChallenge: () => request<UnlockChallengeResponse>('/security/lock/challenge'),
  setupLock: (body: { salt: string; pinHash: string; argon2Params: Argon2ParamsDto }) =>
    request<LockStatusResponse>('/security/lock/setup', { method: 'POST', body: JSON.stringify(body) }),
  changeLockPin: (body: { currentPinHash: string; newSalt: string; newPinHash: string; newArgon2Params: Argon2ParamsDto }) =>
    request<{ changed: boolean }>('/security/lock/change-pin', { method: 'POST', body: JSON.stringify(body) }),
  // A wrong PIN (401) or a revoked lock (423) are expected outcomes carrying
  // a real body, not transport errors - handled here instead of via the
  // generic request() helper, which would otherwise discard that body.
  attemptUnlock: async (pinHash: string): Promise<UnlockResultResponse> => {
    const response = await fetch('/api/security/lock/unlock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ pinHash }),
    });
    const body = await response.json().catch(() => ({}));
    if (response.ok || response.status === 401 || response.status === 423) {
      return body as UnlockResultResponse;
    }
    throw new ApiError(response.status, body.error ?? 'UNKNOWN_ERROR', body.message ?? response.statusText);
  },
  listHumanTakeoverAlerts: (includeIdentity = false) =>
    request<{ alerts: HumanTakeoverAlertDto[] }>(`/security/alerts/human-takeover${includeIdentity ? '?includeIdentity=true' : ''}`),

  getPreferences: () => request<{ preferences: UserPreferencesDto }>('/auth/preferences'),
  updatePreferences: (body: { country?: string | null; navigationOrder?: string[] | null; timezone?: string; language?: string }) =>
    request<{ preferences: UserPreferencesDto }>('/auth/preferences', { method: 'PATCH', body: JSON.stringify(body) }),
  getBootstrapStatus: () => request<BootstrapStatusResponse>('/auth/bootstrap-status'),
  registerAccount: (body: { email: string; password: string; displayName: string }) =>
    request<AuthMeResponse>('/auth/register', { method: 'POST', body: JSON.stringify(body) }),
  registerTrial: (body: { name: string; email: string; phone: string; password: string; productKey: string }) =>
    request<RegisterTrialResponse>('/trials/register', { method: 'POST', body: JSON.stringify(body) }),
  login: (email: string, password: string, rememberMe = true) =>
    request<AuthMeResponse>('/auth/login', { method: 'POST', body: JSON.stringify({ email, password, rememberMe }) }),
  logout: () => request<{ status: string }>('/auth/logout', { method: 'POST' }),
  getMe: () => request<AuthMeResponse>('/auth/me'),
  listSessions: () => request<{ sessions: AuthSessionDto[] }>('/auth/sessions'),
  revokeSession: (id: string) => request<{ status: string }>(`/auth/sessions/${id}`, { method: 'DELETE' }),
  revokeOtherSessions: () => request<{ revokedCount: number }>('/auth/sessions/revoke-others', { method: 'POST' }),
  renameSession: (id: string, deviceName: string) =>
    request<{ sessions: AuthSessionDto[] }>(`/auth/sessions/${id}`, { method: 'PATCH', body: JSON.stringify({ deviceName }) }),
  /** Section 75-91: real, cascading account deletion (accountDeletionService.ts) - OWNER only, revokes every session for this business including the caller's own. */
  deleteAccount: () => request<{ status: 'deletion_scheduled'; scheduledPurgeAt: string }>('/auth/account/delete', { method: 'POST' }),
  cancelAccountDeletion: () => request<{ status: 'deletion_cancelled' }>('/auth/account/delete/cancel', { method: 'POST' }),

  listMembers: () => request<{ members: MemberDto[] }>('/workspace/members'),
  createMember: (body: { email: string; displayName: string; role: BusinessRole }) =>
    request<{ member: MemberDto; temporaryPassword: string }>('/workspace/members', { method: 'POST', body: JSON.stringify(body) }),
  updateMemberRole: (membershipId: string, role: BusinessRole) =>
    request<{ member: MemberDto }>(`/workspace/members/${membershipId}/role`, { method: 'PATCH', body: JSON.stringify({ role }) }),
  removeMember: (membershipId: string) => request<{ status: string }>(`/workspace/members/${membershipId}`, { method: 'DELETE' }),

  listNotifications: () => request<{ notifications: NotificationDto[]; unreadCount: number }>('/workspace/notifications'),
  markNotificationRead: (id: string) =>
    request<{ notification: NotificationDto }>(`/workspace/notifications/${id}/read`, { method: 'PATCH' }),
  dismissNotification: (id: string) =>
    request<{ notification: NotificationDto }>(`/workspace/notifications/${id}/dismiss`, { method: 'PATCH' }),
  markAllNotificationsRead: () => request<{ updatedCount: number }>('/workspace/notifications/read-all', { method: 'POST' }),

  listTeams: () => request<{ teams: TeamDto[] }>('/workspace/teams'),
  createTeam: (name: string, description: string | null) =>
    request<{ team: TeamDto }>('/workspace/teams', { method: 'POST', body: JSON.stringify({ name, description }) }),
  updateTeam: (teamId: string, input: { name?: string; description?: string | null }) =>
    request<{ team: TeamDto }>(`/workspace/teams/${teamId}`, { method: 'PATCH', body: JSON.stringify(input) }),
  deleteTeam: (teamId: string) => request<{ status: string }>(`/workspace/teams/${teamId}`, { method: 'DELETE' }),
  addTeamMember: (teamId: string, userId: string) =>
    request<{ members: TeamMemberDto[] }>(`/workspace/teams/${teamId}/members`, { method: 'POST', body: JSON.stringify({ userId }) }),
  removeTeamMember: (teamId: string, userId: string) =>
    request<{ members: TeamMemberDto[] }>(`/workspace/teams/${teamId}/members/${userId}`, { method: 'DELETE' }),

  listCapacity: () => request<{ capacity: CapacitySummaryDto[] }>('/workspace/capacity'),
  getMyCapacity: () => request<{ capacity: AgentCapacityDto }>('/workspace/capacity/me'),
  updateMyCapacity: (input: { maxActiveConversations?: number; availability?: AgentAvailability }) =>
    request<{ capacity: AgentCapacityDto }>('/workspace/capacity/me', { method: 'PATCH', body: JSON.stringify(input) }),

  assignChat: (chatId: string, input: { assigneeUserId: string | null; assigneeTeamId: string | null }) =>
    request<{ chat: WorkspaceChatDetailRecord }>(`/workspace/chats/${chatId}/assignment`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),

  listEligibleCampaignRecipients: () => request<{ recipients: EligibleRecipientDto[] }>('/workspace/campaigns/eligible-recipients'),
  listCampaigns: () => request<{ campaigns: CampaignDto[] }>('/workspace/campaigns'),
  createCampaign: (input: {
    name: string;
    messageText: string;
    crmContactIds: string[];
    /** Section 27-30: an optional real WhatsApp attachment (image/video/document), sent via the same real pipeline the 1:1 composer already uses. */
    attachment?: { messageType: Exclude<CampaignMessageType, 'text'>; mediaBase64: string; mediaMimeType: string; mediaFileName?: string };
  }) => request<CreateCampaignResultDto>('/workspace/campaigns', { method: 'POST', body: JSON.stringify(input) }),
  getCampaign: (campaignId: string) => request<CampaignDetailDto>(`/workspace/campaigns/${campaignId}`),
  updateCampaign: (
    campaignId: string,
    input: {
      name: string;
      messageText: string;
      attachment?: { messageType: Exclude<CampaignMessageType, 'text'>; mediaBase64: string; mediaMimeType: string; mediaFileName?: string };
      removeAttachment?: boolean;
    },
  ) => request<{ campaign: CampaignDto }>(`/workspace/campaigns/${campaignId}`, { method: 'PATCH', body: JSON.stringify(input) }),
  submitCampaignForReview: (campaignId: string) =>
    request<{ campaign: CampaignDto }>(`/workspace/campaigns/${campaignId}/submit-review`, { method: 'POST' }),
  approveCampaign: (campaignId: string) => request<{ campaign: CampaignDto }>(`/workspace/campaigns/${campaignId}/approve`, { method: 'POST' }),
  sendCampaign: (campaignId: string) => request<{ campaign: CampaignDto }>(`/workspace/campaigns/${campaignId}/send`, { method: 'POST' }),
  cancelCampaign: (campaignId: string) => request<{ campaign: CampaignDto }>(`/workspace/campaigns/${campaignId}/cancel`, { method: 'POST' }),
  deleteCampaign: (campaignId: string) => request<void>(`/workspace/campaigns/${campaignId}`, { method: 'DELETE' }),

  /**
   * Real WhatsApp delete-for-everyone. A 202 means the instruction was
   * queued for WhatsApp, not that recipients' devices have already dropped
   * the message - keep any wording you attach to these honest.
   */
  revokeMessage: (messageId: string) =>
    request<{ status: 'requested' }>(`/workspace/messages/${messageId}/revoke`, { method: 'POST' }),
  recallCampaign: (campaignId: string) =>
    request<{ queued: number; skipped: { messageId: string; reason: string }[] }>(
      `/workspace/campaigns/${campaignId}/recall`,
      { method: 'POST' },
    ),
  revokeScheduledStatus: (id: string) =>
    request<{ status: 'requested' }>(`/workspace/scheduled-statuses/${id}/revoke`, { method: 'POST' }),

  getAiEngines: () => request<AiEnginesDto>('/workspace/ai-engines'),
  testGeminiConnection: () => request<GeminiTestResultDto>('/workspace/ai-engines/gemini/test', { method: 'POST' }),

  getEmailCapabilities: () => request<EmailCapabilitiesDto>('/workspace/email/capabilities'),
  getEmailSettings: () => request<{ settings: EmailSettingsDto | null }>('/workspace/email/settings'),
  updateEmailSettings: (input: {
    provider: EmailProviderKind;
    fromEmail: string;
    fromName?: string | null;
    replyToEmail?: string | null;
    /** Omit to keep the stored secret; '' clears it. Never send back a value you did not type. */
    resendApiKey?: string;
    smtpHost?: string | null;
    smtpPort?: number | null;
    smtpSecure?: boolean;
    smtpUsername?: string | null;
    smtpPassword?: string;
  }) => request<{ settings: EmailSettingsDto }>('/workspace/email/settings', { method: 'PUT', body: JSON.stringify(input) }),
  sendTestEmail: (toEmail: string) =>
    request<{ status: 'ok'; detail: string } | { status: 'failed'; reason: string }>('/workspace/email/test', {
      method: 'POST',
      body: JSON.stringify({ toEmail }),
    }),

  listEmails: (status?: EmailStatus) =>
    request<{ emails: EmailMessageDto[] }>(`/workspace/email${status ? `?status=${status}` : ''}`),
  createEmailDraft: (input: {
    kind: EmailKind;
    toEmail: string;
    toName?: string | null;
    subject: string;
    bodyText: string;
  }) => request<{ email: EmailMessageDto }>('/workspace/email', { method: 'POST', body: JSON.stringify(input) }),
  updateEmailDraft: (id: string, input: { toEmail: string; toName?: string | null; subject: string; bodyText: string }) =>
    request<{ email: EmailMessageDto }>(`/workspace/email/${id}`, { method: 'PATCH', body: JSON.stringify(input) }),
  /** The only path to sending. Requires the email.send permission server-side. */
  approveEmail: (id: string) => request<{ email: EmailMessageDto }>(`/workspace/email/${id}/approve`, { method: 'POST' }),
  cancelEmail: (id: string) => request<{ email: EmailMessageDto }>(`/workspace/email/${id}/cancel`, { method: 'POST' }),
  deleteEmail: (id: string) => request<{ ok: boolean }>(`/workspace/email/${id}`, { method: 'DELETE' }),
  aiDraftEmail: (input: {
    agentId: string;
    kind: EmailKind;
    toEmail: string;
    toName?: string | null;
    instruction: string;
    facts?: string | null;
  }) =>
    request<{ status: 'drafted'; email: EmailMessageDto } | { status: 'unavailable'; reason: string }>(
      '/workspace/email/ai-draft',
      { method: 'POST', body: JSON.stringify(input) },
    ),

  listScheduledStatuses: () => request<{ statuses: ScheduledStatusDto[] }>('/workspace/scheduled-statuses'),
  createScheduledStatus: (input: {
    statusType: 'text' | 'image' | 'video';
    textContent?: string;
    caption?: string;
    backgroundColor?: string;
    mediaBase64?: string;
    mediaMimeType?: string;
    scheduledAt: string;
  }) => request<{ status: ScheduledStatusDto }>('/workspace/scheduled-statuses', { method: 'POST', body: JSON.stringify(input) }),
  scheduleStatus: (id: string) => request<{ status: ScheduledStatusDto }>(`/workspace/scheduled-statuses/${id}/schedule`, { method: 'POST' }),
  cancelScheduledStatus: (id: string) => request<{ status: ScheduledStatusDto }>(`/workspace/scheduled-statuses/${id}/cancel`, { method: 'POST' }),
  deleteScheduledStatus: (id: string) => request<{ ok: boolean }>(`/workspace/scheduled-statuses/${id}`, { method: 'DELETE' }),
  listStatusReplies: (id: string) => request<{ replies: StatusReplyDto[] }>(`/workspace/scheduled-statuses/${id}/replies`),

  listFunnels: () => request<{ funnels: FunnelDto[] }>('/workspace/funnels'),
  createFunnel: (name: string, description: string | null) =>
    request<{ funnel: FunnelDto }>('/workspace/funnels', { method: 'POST', body: JSON.stringify({ name, description }) }),
  getFunnel: (funnelId: string) => request<FunnelDetailDto>(`/workspace/funnels/${funnelId}`),
  updateFunnel: (funnelId: string, name: string, description: string | null) =>
    request<{ funnel: FunnelDto }>(`/workspace/funnels/${funnelId}`, { method: 'PATCH', body: JSON.stringify({ name, description }) }),
  deleteFunnel: (funnelId: string) => request<{ status: string }>(`/workspace/funnels/${funnelId}`, { method: 'DELETE' }),
  replaceFunnelSteps: (funnelId: string, steps: { nodeType: FunnelNodeType; config: Record<string, unknown> }[]) =>
    request<{ steps: FunnelStepDto[] }>(`/workspace/funnels/${funnelId}/steps`, { method: 'PUT', body: JSON.stringify({ steps }) }),
  activateFunnel: (funnelId: string) => request<{ funnel: FunnelDto }>(`/workspace/funnels/${funnelId}/activate`, { method: 'POST' }),
  deactivateFunnel: (funnelId: string) => request<{ funnel: FunnelDto }>(`/workspace/funnels/${funnelId}/deactivate`, { method: 'POST' }),
  enrollInFunnel: (funnelId: string, crmContactId: string) =>
    request<{ instance: FunnelInstanceDto }>(`/workspace/funnels/${funnelId}/enroll`, { method: 'POST', body: JSON.stringify({ crmContactId }) }),
  cancelFunnelInstance: (funnelId: string, instanceId: string) =>
    request<{ instance: FunnelInstanceDto }>(`/workspace/funnels/${funnelId}/instances/${instanceId}/cancel`, { method: 'POST' }),

  suggestMarketingCopy: (input: { kind: 'campaign_message' | 'status_caption' | 'follow_up'; businessContext: string; count?: number }) =>
    request<MarketingCopySuggestionResult>('/workspace/marketing/ai-suggest', { method: 'POST', body: JSON.stringify(input) }),

  getReplySuggestions: (chatId: string) =>
    request<ReplySuggestionResult>(`/workspace/chats/${chatId}/reply-suggestions`),

  globalSearch: (query: string) => request<{ results: GlobalSearchResult[] }>(`/workspace/search?q=${encodeURIComponent(query)}`),

  listKnowledgeBaseDocuments: () => request<{ documents: KnowledgeBaseDocumentDto[] }>('/workspace/knowledge-base'),
  createKnowledgeBaseDocument: (title: string, content: string) =>
    request<{ document: KnowledgeBaseDocumentDto }>('/workspace/knowledge-base', { method: 'POST', body: JSON.stringify({ title, content }) }),
  updateKnowledgeBaseDocument: (documentId: string, title: string, content: string) =>
    request<{ document: KnowledgeBaseDocumentDto }>(`/workspace/knowledge-base/${documentId}`, {
      method: 'PATCH',
      body: JSON.stringify({ title, content }),
    }),
  deleteKnowledgeBaseDocument: (documentId: string) =>
    request<{ status: string }>(`/workspace/knowledge-base/${documentId}`, { method: 'DELETE' }),

  listBusinessDocuments: () => request<{ documents: BusinessDocumentDto[] }>('/workspace/documents'),
  uploadBusinessDocument: (filename: string, mimeType: string, fileBase64: string) =>
    request<{ document: BusinessDocumentDto }>('/workspace/documents', {
      method: 'POST',
      body: JSON.stringify({ filename, mimeType, fileBase64 }),
    }),
  deleteBusinessDocument: (documentId: string) =>
    request<{ status: string }>(`/workspace/documents/${documentId}`, { method: 'DELETE' }),

  getControlPlaneStats: () =>
    request<{
      stats: {
        totalBusinesses: number;
        activeWaConnections: number;
        totalAiAgents: number;
        activeTrials: number;
        recentSecurityEvents: number;
      };
    }>('/platform/developer/control-plane-stats'),
  getSystemHealth: () =>
    request<{
      database: { available: boolean; error: string | null };
      redis: { available: boolean; error: string | null };
      queues: { healthy: boolean; queues: Array<{ name: string; waiting: number; active: number; completed: number; failed: number; delayed: number; healthy: boolean }> };
      goose: { configured: boolean; reachable: boolean; reason?: string; lastSuccessAt: string | null; lastFailureAt: string | null; lastFailureReason: string | null; consecutiveFailureCount: number };
      ai: { configured: boolean; model: string };
    }>('/platform/developer/system-health'),
  getAiUsageOverview: () =>
    request<{
      last24h: { totalTokens: number; callCount: number };
      last7d: { totalTokens: number; callCount: number };
      topBusinessesLast24h: Array<{ businessId: string; businessName: string; totalTokens: number; callCount: number }>;
    }>('/platform/developer/ai-usage'),

  // ── Autonomous operations kill switch (developer-only, Section 41-42 Phase 1) ──
  getAutonomyKillSwitch: () =>
    request<{ enabled: boolean }>('/platform/developer/autonomy-kill-switch'),
  setAutonomyKillSwitch: (enabled: boolean) =>
    request<{ enabled: boolean }>('/platform/developer/autonomy-kill-switch', { method: 'PATCH', body: JSON.stringify({ enabled }) }),

  // ── Plan management (developer-only) ────────────────────────────────────────
  listPlans: () =>
    request<{ plans: DeveloperPlan[] }>('/billing/developer/plans'),
  updatePlan: (planId: string, input: UpdatePlanBody) =>
    request<{ plan: DeveloperPlan }>(`/billing/developer/plans/${planId}`, { method: 'PATCH', body: JSON.stringify(input) }),
  upsertPlanEntitlement: (planId: string, entitlementKey: string, input: { limitValue: number | null; isEnabled: boolean }) =>
    request<{ entitlement: PlanEntitlement }>(`/billing/developer/plans/${planId}/entitlements/${encodeURIComponent(entitlementKey)}`, {
      method: 'PUT',
      body: JSON.stringify(input),
    }),

  // ── Payment providers (developer-only, Section 73-74) ───────────────────────
  listPaymentProviders: () =>
    request<{ providers: { kind: string; configured: boolean; enabled: boolean }[] }>('/billing/developer/payment-providers'),
  togglePaymentProvider: (kind: string, enabled: boolean) =>
    request<{ setting: { key: string; value: unknown } }>(`/billing/developer/payment-providers/${kind}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled }),
    }),

  // ── Operator Mode ──────────────────────────────────────────────────────────
  getOperatorSettings: () =>
    request<{ configured: false } | { configured: true; operatorWaJid: string; enabled: boolean; createdAt: string; updatedAt: string }>(
      '/operator-mode/settings',
    ),
  setOperatorSettings: (input: { operatorWaJid: string; pin: string; enabled?: boolean }) =>
    request<{ configured: true; operatorWaJid: string; enabled: boolean; updatedAt: string }>(
      '/operator-mode/settings',
      { method: 'POST', body: JSON.stringify(input) },
    ),
  setOperatorEnabled: (enabled: boolean) =>
    request<{ enabled: boolean }>('/operator-mode/settings/enabled', {
      method: 'PATCH',
      body: JSON.stringify({ enabled }),
    }),
  killOperatorSession: () =>
    request<{ ok: boolean }>('/operator-mode/session', { method: 'DELETE' }),
  generateOperatorSetupToken: () =>
    request<{ token: string }>('/operator-mode/setup-token', { method: 'POST' }),
  hasOperatorSetupToken: () =>
    request<{ exists: boolean }>('/operator-mode/setup-token'),
  revokeOperatorSetupToken: () =>
    request<{ ok: boolean }>('/operator-mode/setup-token', { method: 'DELETE' }),

  // ── Invoices ───────────────────────────────────────────────────────────────
  listInvoices: (opts?: { status?: string; type?: string }) =>
    request<{ invoices: InvoiceDto[] }>(
      `/invoices${opts ? `?${new URLSearchParams(Object.fromEntries(Object.entries(opts).filter(([, v]) => v != null) as [string, string][])).toString()}` : ''}`,
    ),
  createInvoice: (input: CreateInvoiceInput) =>
    request<{ invoice: InvoiceDto; lineItems: InvoiceLineItemDto[] }>('/invoices', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  getInvoice: (id: string) =>
    request<{ invoice: InvoiceDto; lineItems: InvoiceLineItemDto[] }>(`/invoices/${id}`),
  patchInvoice: (id: string, patch: Partial<Pick<InvoiceDto, 'notes' | 'terms' | 'footerText' | 'dueDate' | 'taxBasisPoints' | 'currencyCode'>>) =>
    request<{ invoice: InvoiceDto }>(`/invoices/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  submitInvoice: (id: string) => request<{ invoice: InvoiceDto }>(`/invoices/${id}/submit`, { method: 'POST' }),
  approveInvoice: (id: string) => request<{ invoice: InvoiceDto }>(`/invoices/${id}/approve`, { method: 'POST' }),
  sendInvoice: (id: string) => request<{ invoice: InvoiceDto }>(`/invoices/${id}/send`, { method: 'POST' }),
  markInvoicePaid: (id: string) => request<{ invoice: InvoiceDto }>(`/invoices/${id}/pay`, { method: 'POST' }),
  cancelInvoice: (id: string) => request<{ invoice: InvoiceDto }>(`/invoices/${id}/cancel`, { method: 'POST' }),
  voidInvoice: (id: string) => request<{ invoice: InvoiceDto }>(`/invoices/${id}/void`, { method: 'POST' }),
  deleteInvoice: (id: string) => request<Record<string, never>>(`/invoices/${id}`, { method: 'DELETE' }),
  invoiceHtmlUrl: (id: string) => `/api/invoices/${id}/html`,

  // ── Email OAuth ────────────────────────────────────────────────────────────
  listOAuthAccounts: () =>
    request<{
      accounts: Array<{
        id: string;
        provider: 'gmail' | 'outlook';
        emailAddress: string;
        displayName: string | null;
        lastSyncedAt: string | null;
        syncEnabled: boolean;
      }>;
    }>('/email-oauth/accounts'),
  disconnectOAuthAccount: (id: string) =>
    request<{ ok: boolean }>(`/email-oauth/accounts/${id}`, { method: 'DELETE' }),
  syncOAuthAccount: (accountId: string) =>
    request<{ ok: boolean }>(`/email-oauth/sync/${accountId}`, { method: 'POST' }),
  getOAuthMessages: (accountId: string, opts?: { limit?: number; unread?: boolean }) => {
    const qs = new URLSearchParams();
    if (opts?.limit) qs.set('limit', String(opts.limit));
    if (opts?.unread) qs.set('unread', 'true');
    const q = qs.toString();
    return request<{
      messages: Array<{
        id: string;
        accountId: string;
        providerMessageId: string;
        providerThreadId: string | null;
        folder: string;
        subject: string | null;
        fromAddress: string | null;
        fromName: string | null;
        toAddresses: string | null;
        snippet: string | null;
        isRead: boolean;
        isStarred: boolean;
        labels: string[];
        receivedAt: string | null;
      }>;
    }>(`/email-oauth/messages/${accountId}${q ? `?${q}` : ''}`);
  },
  oauthConnectUrl: (provider: 'gmail' | 'outlook') => `/api/email-oauth/connect/${provider}`,

  // ── Meeting booking OAuth (Google Meet, Zoom) ──────────────────────────────
  getMeetingConnection: (provider: 'google_meet' | 'zoom') =>
    request<{ connection: { id: string; email: string; displayName: string | null; createdAt: string } | null }>(
      `/meeting-oauth/connection/${provider}`,
    ),
  disconnectMeetingConnection: (provider: 'google_meet' | 'zoom') =>
    request<{ ok: boolean }>(`/meeting-oauth/connection/${provider}`, { method: 'DELETE' }),
  meetingOauthConnectUrl: (provider: 'google_meet' | 'zoom') => `/api/meeting-oauth/connect/${provider}`,

  // ── Legal & Consent (public — no auth required) ───────────────────────────
  getLegalDocuments: () =>
    request<{
      terms: { version: string; title: string; contentHtml: string; effectiveAt: string } | null;
      privacy: { version: string; title: string; contentHtml: string; effectiveAt: string } | null;
    }>('/legal/documents'),
  recordConsent: (input: {
    fullName: string;
    email: string;
    phone: string;
    termsVersion: string;
    privacyVersion: string;
    marketingOptIn: boolean;
  }) => request<{ consentId: string; qrCodeDataUrl: string }>('/legal/consent', { method: 'POST', body: JSON.stringify(input) }),
  confirmConsent: (token: string) =>
    request<
      | { status: 'confirmed'; email: string; fullName: string }
      | { status: 'already_confirmed' }
      | { status: 'expired' }
      | { status: 'not_found' }
      | { status: 'already_used' }
    >(`/legal/consent/confirm?token=${encodeURIComponent(token)}`),

  // ── Developer — Vertical Catalog ──────────────────────────────────────────
  listVerticals: () =>
    request<{
      verticals: Array<{ id: string; product_key: string; name: string; description: string; is_active: boolean }>;
    }>('/platform/developer/verticals'),
  assignVertical: (businessId: string, productKey: string) =>
    request<{ ok: boolean; businessId: string; productKey: string }>(
      `/platform/developer/accounts/${businessId}/assign-vertical`,
      { method: 'POST', body: JSON.stringify({ productKey }) },
    ),
  listAllProductAccountsDev: () =>
    request<{
      accounts: Array<{
        id: string; businessId: string; productId: string; productKey: string;
        displayName: string; status: string; ownerUserId: string | null;
      }>;
    }>('/platform/developer/product-accounts'),
  listDeveloperTrials: () =>
    request<{
      trials: Array<{
        id: string; email: string; productKey: string;
        state: 'CREATED' | 'ACTIVE' | 'EXPIRING' | 'EXPIRED' | 'CONVERTED' | 'CANCELLED';
        startsAt: string | null; endsAt: string | null; expiredAt: string | null; convertedAt: string | null;
        createdAt: string;
      }>;
    }>('/developer/trials'),
};
