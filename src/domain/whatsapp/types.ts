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

export type MediaDownloadStatus = 'pending' | 'downloading' | 'downloaded' | 'failed' | 'unavailable';

export type MediaProcessingStatus = 'pending' | 'processing' | 'processed' | 'failed' | 'skipped';

export type CallType = 'voice' | 'video' | 'unknown';

export type CallStatus = 'offer' | 'ringing' | 'accepted' | 'rejected' | 'missed' | 'timeout' | 'ended' | 'unknown';

export type StatusType = 'text' | 'image' | 'video' | 'audio' | 'unknown';

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
