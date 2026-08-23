export type ConnectionStatus =
  | 'DISCONNECTED'
  | 'CONNECTING'
  | 'QR_READY'
  | 'CONNECTED'
  | 'RECONNECTING'
  | 'LOGGED_OUT'
  | 'ERROR';

export type SyncStatus = 'not_started' | 'in_progress' | 'completed' | 'failed';

export type SourceType = 'whatsapp' | 'manual' | 'google' | 'crm' | 'system';

export type PresenceState = 'available' | 'unavailable' | 'composing' | 'recording' | 'paused' | 'unknown';

export type ChatType = 'individual' | 'group' | 'broadcast' | 'status' | 'newsletter' | 'other';

export type GroupMemberRole = 'member' | 'admin' | 'superadmin';

export type MessageDirection = 'inbound' | 'outbound';

export type MessageType =
  | 'text'
  | 'image'
  | 'audio'
  | 'voice_note'
  | 'video'
  | 'document'
  | 'spreadsheet'
  | 'sticker'
  | 'location'
  | 'contact'
  | 'contacts'
  | 'reaction'
  | 'poll'
  | 'poll_response'
  | 'button'
  | 'interactive'
  | 'system'
  | 'call_event'
  | 'unknown';

export type MessageStatus = 'pending' | 'sent' | 'delivered' | 'read' | 'played' | 'failed' | 'unknown';

export type MediaType = 'image' | 'video' | 'audio' | 'voice_note' | 'document' | 'sticker';

export type MediaStorageProvider = 'pending' | 'local' | 's3' | 'gcs';

/**
 * 'retry_scheduled' (Phase 2B): a classified-retryable failure occurred and
 * a further attempt (automatic or manual) is expected but not yet running -
 * distinct from 'failed', which is now specifically terminal (retries
 * exhausted, or a non-retryable error). See
 * docs/PHASE_2A_MEDIA_RETRY_AUDIT_AND_PROPOSAL.md section 2.
 */
export type MediaDownloadStatus =
  | 'pending'
  | 'downloading'
  | 'downloaded'
  | 'retry_scheduled'
  | 'failed'
  | 'unavailable';

/** Phase 2B retryable/terminal error taxonomy - see PHASE_2A proposal section 3. */
export type MediaDownloadErrorCategory =
  | 'network'
  | 'oversized'
  | 'checksum_mismatch'
  | 'expired'
  | 'internal';

export type MediaProcessingStatus = 'pending' | 'processing' | 'processed' | 'failed' | 'skipped';

export type CallType = 'voice' | 'video' | 'unknown';

export type CallStatus = 'offer' | 'ringing' | 'accepted' | 'rejected' | 'missed' | 'timeout' | 'ended' | 'unknown';

export type StatusType = 'text' | 'image' | 'video' | 'audio' | 'unknown';

/**
 * WhatsApp's fixed JID for Status updates - not a real conversation.
 * Single shared source so every ingestion path (live messages.upsert,
 * historical messaging-history.set) tests the same value rather than
 * each maintaining its own private copy of this literal.
 */
export const STATUS_BROADCAST_JID = 'status@broadcast';

export type ConnectionEventType =
  | 'connecting'
  | 'qr_generated'
  | 'connected'
  | 'disconnected'
  | 'reconnecting'
  | 'logged_out'
  | 'error';

export type SyncType =
  | 'initial'
  | 'history'
  | 'contacts'
  | 'chats'
  | 'groups'
  | 'messages'
  | 'media'
  | 'incremental'
  | 'repair'
  | 'on_demand';

export type SyncJobStatus = 'pending' | 'running' | 'completed' | 'partial' | 'failed' | 'cancelled';

export type JidMappingSource = 'baileys_alt_jid' | 'manual' | 'verified';

export type MappingConfidence = 'high' | 'medium' | 'low';

export type OutboundMessageStatus = 'queued' | 'sending' | 'sent' | 'failed' | 'indeterminate';

/** 'voice_note' is a real WhatsApp PTT message, not an audio attachment - the two render differently for the recipient. */
export type OutboundMessageType = 'text' | 'image' | 'video' | 'audio' | 'voice_note' | 'document';
