export interface WhatsAppConnectionSnapshot {
  status: 'DISCONNECTED' | 'CONNECTING' | 'QR_READY' | 'CONNECTED' | 'RECONNECTING' | 'LOGGED_OUT' | 'ERROR';
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
  /** This account's own real, downloaded profile picture media row - null until a sync has actually succeeded. */
  avatarMediaId: string | null;
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
  downloadStatus: 'pending' | 'downloading' | 'downloaded' | 'failed' | 'unavailable';
}

export interface WorkspaceReaction {
  reactorJid: string;
  reaction: string;
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
      messageType: 'image' | 'video' | 'audio' | 'document';
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

export interface UpdateCrmContactBody {
  stage: string | null;
  leadStatus: string | null;
  notes: string | null;
  tags: string[];
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

export interface WorkspaceBusiness {
  id: string;
  name: string;
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

export interface AuthSessionDto {
  id: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  ipAddress: string | null;
  browser: string;
  os: string;
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
}

export interface CampaignDto {
  id: string;
  businessId: string;
  whatsappAccountId: string;
  createdBy: string;
  name: string;
  messageText: string;
  status: CampaignStatus;
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
  status: 'queued' | 'sending' | 'sent' | 'delivered' | 'read' | 'played' | 'failed' | null;
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
  createdAt: string;
  updatedAt: string;
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

export interface AiAgentSummary {
  id: string;
  name: string;
  status: 'ACTIVE' | 'PAUSED' | 'ARCHIVED';
  persona: string | null;
}

export interface CreateAgentBody {
  name: string;
  persona?: string;
  tone?: string;
  language?: string;
  systemInstruction?: string;
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

export const api = {
  getWhatsAppStatus: () => request<WhatsAppConnectionSnapshot>('/whatsapp/status'),
  connectWhatsApp: () => request<WhatsAppConnectionSnapshot>('/whatsapp/connect', { method: 'POST' }),
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
  getBilling: () => request<WorkspaceBillingOverview>('/workspace/billing'),
  getDashboard: () => request<WorkspaceDashboardOverview>('/workspace/dashboard'),
  getBusiness: () => request<{ business: WorkspaceBusiness }>('/workspace/business'),
  updateBusiness: (name: string) =>
    request<{ business: WorkspaceBusiness }>('/workspace/business', { method: 'PATCH', body: JSON.stringify({ name }) }),
  /** Pushes a real profile picture to WhatsApp itself (Baileys updateProfilePicture) - never just a local-only avatar swap. */
  updateAccountProfilePicture: (imageBase64: string, mimeType: string) =>
    request<{ status: string }>('/workspace/account/profile-picture', {
      method: 'PUT',
      body: JSON.stringify({ imageBase64, mimeType }),
    }),
  listAgents: () => request<{ agents: AiAgentSummary[] }>('/workspace/agents'),
  createAgent: (body: CreateAgentBody) =>
    request<{ agent: AiAgentSummary }>('/workspace/agents', { method: 'POST', body: JSON.stringify(body) }),
  updateAgentStatus: (id: string, status: AiAgentSummary['status']) =>
    request<{ agent: AiAgentSummary }>(`/workspace/agents/${id}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    }),
  listCrmContacts: () => request<{ crmContacts: WorkspaceCrmContactSummary[] }>('/workspace/crm-contacts'),
  updateCrmContact: (id: string, body: UpdateCrmContactBody) =>
    request<{ crmContact: WorkspaceCrmContactSummary }>(`/workspace/crm-contacts/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
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
  listHumanTakeoverAlerts: () => request<{ alerts: HumanTakeoverAlertDto[] }>('/security/alerts/human-takeover'),

  getBootstrapStatus: () => request<BootstrapStatusResponse>('/auth/bootstrap-status'),
  registerAccount: (body: { email: string; password: string; displayName: string }) =>
    request<AuthMeResponse>('/auth/register', { method: 'POST', body: JSON.stringify(body) }),
  login: (email: string, password: string) =>
    request<AuthMeResponse>('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
  logout: () => request<{ status: string }>('/auth/logout', { method: 'POST' }),
  getMe: () => request<AuthMeResponse>('/auth/me'),
  listSessions: () => request<{ sessions: AuthSessionDto[] }>('/auth/sessions'),
  revokeSession: (id: string) => request<{ status: string }>(`/auth/sessions/${id}`, { method: 'DELETE' }),
  revokeOtherSessions: () => request<{ revokedCount: number }>('/auth/sessions/revoke-others', { method: 'POST' }),

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
  createCampaign: (input: { name: string; messageText: string; crmContactIds: string[] }) =>
    request<CreateCampaignResultDto>('/workspace/campaigns', { method: 'POST', body: JSON.stringify(input) }),
  getCampaign: (campaignId: string) => request<CampaignDetailDto>(`/workspace/campaigns/${campaignId}`),
  updateCampaign: (campaignId: string, input: { name: string; messageText: string }) =>
    request<{ campaign: CampaignDto }>(`/workspace/campaigns/${campaignId}`, { method: 'PATCH', body: JSON.stringify(input) }),
  submitCampaignForReview: (campaignId: string) =>
    request<{ campaign: CampaignDto }>(`/workspace/campaigns/${campaignId}/submit-review`, { method: 'POST' }),
  approveCampaign: (campaignId: string) => request<{ campaign: CampaignDto }>(`/workspace/campaigns/${campaignId}/approve`, { method: 'POST' }),
  sendCampaign: (campaignId: string) => request<{ campaign: CampaignDto }>(`/workspace/campaigns/${campaignId}/send`, { method: 'POST' }),
  cancelCampaign: (campaignId: string) => request<{ campaign: CampaignDto }>(`/workspace/campaigns/${campaignId}/cancel`, { method: 'POST' }),

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
};
