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

export interface AiAgentSummary {
  id: string;
  name: string;
  status: 'ACTIVE' | 'PAUSED' | 'ARCHIVED';
  persona: string | null;
}

export interface WorkspaceContact {
  id: string;
  whatsappJid: string;
  phoneNumber: string | null;
  displayName: string | null;
  pushName: string | null;
  aboutText: string | null;
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
  listAgents: () => request<{ agents: AiAgentSummary[] }>('/workspace/agents'),
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
      body: JSON.stringify({ pinHash }),
    });
    const body = await response.json().catch(() => ({}));
    if (response.ok || response.status === 401 || response.status === 423) {
      return body as UnlockResultResponse;
    }
    throw new ApiError(response.status, body.error ?? 'UNKNOWN_ERROR', body.message ?? response.statusText);
  },
  listHumanTakeoverAlerts: () => request<{ alerts: HumanTakeoverAlertDto[] }>('/security/alerts/human-takeover'),
};
