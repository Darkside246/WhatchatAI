import { useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  ArrowLeft,
  Check,
  CheckCheck,
  Clock,
  AlertCircle,
  Paperclip,
  Send,
  Loader2,
  Download,
  FileText,
  ImageOff,
  FileWarning,
  Bot,
  User as UserIcon,
} from 'lucide-react';
import {
  api,
  mediaUrl,
  type WorkspaceMessage,
  type WorkspaceMedia,
  type WorkspaceChatDetail,
  type WorkspacePresence,
  type SendMessageBody,
} from '../lib/api.js';
import { useWhatsAppSync, type RealtimeEvent } from '../hooks/useWhatsAppSync.js';
import { useTheme } from '../hooks/useTheme.js';
import { THEMES } from '../theme.js';
import { Avatar } from './Avatar.js';

type AiMode = WorkspaceChatDetail['chat']['aiMode'];

/**
 * Real, persisted agent_mode control - every click calls the same
 * setAiMode API the full detail panel uses, never local-only state. The
 * real model has three states (AI_ACTIVE/AI_PAUSED/HUMAN_TAKEOVER); the
 * two primary buttons set AI_ACTIVE/HUMAN_TAKEOVER directly, and AI_PAUSED
 * is shown honestly as its own label rather than forced into either slot.
 */
function AiModeControl({
  mode,
  saving,
  error,
  onSelect,
}: {
  mode: AiMode;
  saving: boolean;
  error: string | null;
  onSelect: (mode: AiMode) => void;
}) {
  return (
    <div className="hidden shrink-0 flex-col items-end gap-1 sm:flex">
      <div className="flex items-center gap-0.5 rounded-full border border-border-subtle bg-surface-2 p-0.5 text-[11px] font-medium">
        <button
          type="button"
          disabled={saving}
          onClick={() => onSelect('AI_ACTIVE')}
          className={`flex items-center gap-1 rounded-full px-2.5 py-1 transition-colors disabled:opacity-50 ${
            mode === 'AI_ACTIVE' ? 'bg-accent text-white' : 'text-fg-secondary hover:text-fg'
          }`}
        >
          <Bot size={12} strokeWidth={2} aria-hidden />
          AI Autonomous
        </button>
        <button
          type="button"
          disabled={saving}
          onClick={() => onSelect('HUMAN_TAKEOVER')}
          className={`flex items-center gap-1 rounded-full px-2.5 py-1 transition-colors disabled:opacity-50 ${
            mode === 'HUMAN_TAKEOVER' ? 'bg-info text-black' : 'text-fg-secondary hover:text-fg'
          }`}
        >
          <UserIcon size={12} strokeWidth={2} aria-hidden />
          Human Agent
        </button>
      </div>
      {saving && <span className="text-[10px] text-fg-muted">Saving…</span>}
      {!saving && mode === 'AI_PAUSED' && <span className="text-[10px] text-warning">AI Paused</span>}
      {!saving && error && <span className="text-[10px] text-error">{error}</span>}
    </div>
  );
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/** Only ever reflects a real, received presence.update event - never inferred from message activity. */
function formatPresence(presence: WorkspacePresence | null): string | null {
  if (!presence) return null;
  if (presence.state === 'available') return 'online';
  if (presence.state === 'composing') return 'typing…';
  if (presence.state === 'recording') return 'recording audio…';
  if (presence.lastSeenAt) {
    return `last seen ${new Date(presence.lastSeenAt).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    })}`;
  }
  return null;
}

/** A real, human-readable stand-in for a non-text message's preview - never the raw internal type name (e.g. `[unknown]`, `[system]`) verbatim. */
const MESSAGE_TYPE_LABELS: Record<string, string> = {
  image: 'Photo',
  audio: 'Audio',
  voice_note: 'Voice message',
  video: 'Video',
  document: 'Document',
  spreadsheet: 'Spreadsheet',
  sticker: 'Sticker',
  location: 'Location',
  contact: 'Contact card',
  contacts: 'Contact cards',
  reaction: 'Reaction',
  poll: 'Poll',
  poll_response: 'Poll response',
  button: 'Button message',
  interactive: 'Interactive message',
  system: 'System message',
  call_event: 'Call',
  unknown: 'Message',
};

function messageBody(message: WorkspaceMessage): string {
  if (message.textContent) return message.textContent;
  if (message.caption) return message.caption;
  return MESSAGE_TYPE_LABELS[message.messageType] ?? 'Message';
}

/** Real reactor rows grouped into WhatsApp-style "emoji count" badges - never fabricated, empty when none exist. */
function groupReactions(reactions: WorkspaceMessage['reactions']): { emoji: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const { reaction } of reactions) counts.set(reaction, (counts.get(reaction) ?? 0) + 1);
  return [...counts.entries()].map(([emoji, count]) => ({ emoji, count }));
}

function formatFileSize(bytes: number | null): string {
  if (bytes === null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Renders the real, decrypted media bytes served by GET /api/media/:id - it
 * never shows an image/video/audio element unless download_status is
 * actually 'downloaded'. Pending/failed/unavailable each get an honest,
 * distinct state instead of a fake preview.
 */
function MediaContent({ media, caption }: { media: WorkspaceMedia; caption: string | null }) {
  // These states render inside either bubble color (outgoing solid-accent or
  // incoming white), so they inherit the bubble's own text color rather than
  // forcing a neutral fg tone that could go illegible against it.
  if (media.downloadStatus === 'pending' || media.downloadStatus === 'downloading') {
    return (
      <div className="flex items-center gap-2 rounded-lg bg-black/10 px-3 py-4 text-xs opacity-90">
        <Loader2 size={16} className="animate-spin" aria-hidden />
        Downloading media…
      </div>
    );
  }
  if (media.downloadStatus === 'unavailable') {
    return (
      <div className="flex items-center gap-2 rounded-lg bg-black/10 px-3 py-4 text-xs opacity-75">
        <ImageOff size={16} aria-hidden />
        This media is no longer available
      </div>
    );
  }
  if (media.downloadStatus === 'failed') {
    return (
      <div className="flex items-center gap-2 rounded-lg bg-black/10 px-3 py-4 text-xs text-error">
        <FileWarning size={16} aria-hidden />
        Media download failed
      </div>
    );
  }

  const url = mediaUrl(media.id);

  if (media.mediaType === 'image' || media.mediaType === 'sticker') {
    return (
      <a href={url} target="_blank" rel="noreferrer">
        <img src={url} alt={caption ?? 'Image attachment'} className="max-h-72 max-w-full rounded-lg object-contain" />
      </a>
    );
  }
  if (media.mediaType === 'video') {
    return <video controls src={url} className="max-h-72 max-w-full rounded-lg" />;
  }
  if (media.mediaType === 'audio' || media.mediaType === 'voice_note') {
    return <audio controls src={url} className="w-64 max-w-full" />;
  }
  return (
    <a
      href={url}
      download={media.fileName ?? undefined}
      className="flex items-center gap-2 rounded-lg bg-black/10 px-3 py-2 text-xs hover:bg-black/15"
    >
      <FileText size={20} aria-hidden />
      <span className="flex flex-col">
        <span className="font-medium">{media.fileName ?? 'Document'}</span>
        <span className="opacity-70">{formatFileSize(media.fileSize)}</span>
      </span>
      <Download size={14} className="ml-2 shrink-0" aria-hidden />
    </a>
  );
}

/** Real delivery-receipt ticks driven by message.status (see messages.update wiring) - never a fabricated state. */
function DeliveryTicks({ status }: { status: WorkspaceMessage['status'] }) {
  if (status === 'failed') return <AlertCircle size={13} className="text-error" aria-label="Failed to send" />;
  // These ticks only ever render inside the outgoing (solid-accent) bubble, so
  // they use the bubble's own foreground token rather than the page-neutral
  // fg tokens, which would be illegible against that background.
  if (status === 'pending') return <Clock size={13} className="text-message-out-fg/50" aria-label="Pending" />;
  if (status === 'sent') return <Check size={14} className="text-message-out-fg/70" aria-label="Sent" />;
  if (status === 'delivered') return <CheckCheck size={14} className="text-message-out-fg/70" aria-label="Delivered" />;
  if (status === 'read' || status === 'played') return <CheckCheck size={14} className="text-message-out-fg" aria-label="Read" />;
  return null;
}

interface Props {
  onOpenDetail?: () => void;
}

export function ChatThread({ onOpenDetail }: Props) {
  const { theme } = useTheme();
  const doodleClass = THEMES.find((t) => t.id === theme)?.doodleClass ?? 'chat-sleek-bg';
  const { chatId } = useParams<{ chatId: string }>();
  const [messages, setMessages] = useState<WorkspaceMessage[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<WorkspaceChatDetail | null>(null);
  const [savingMode, setSavingMode] = useState(false);
  const [modeError, setModeError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function load(currentChatId: string) {
    try {
      const { messages: list } = await api.listMessages(currentChatId);
      setMessages([...list].reverse());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load messages.');
    }
  }

  async function loadDetail(currentChatId: string) {
    try {
      const result = await api.getChatDetail(currentChatId);
      setDetail(result);
    } catch {
      // The header degrades to the loading state; the message list's own
      // error banner is the primary signal for a broken chat load.
    }
  }

  // Real "mark as read": the user is actually looking at this conversation,
  // so its unread counter resets - never a fabricated "seen" state, and
  // never touched for chats the user hasn't opened.
  function markRead(currentChatId: string) {
    void api.markChatRead(currentChatId).catch(() => {
      // Best-effort - a failed read receipt shouldn't surface as a page error.
    });
  }

  async function handleModeSelect(mode: AiMode) {
    if (!chatId || !detail || savingMode) return;
    const targetChatId = chatId;
    setSavingMode(true);
    setModeError(null);
    try {
      await api.setAiMode(targetChatId, mode);
      // Guard against the chat having changed while the request was in flight.
      if (targetChatId === chatId) {
        setDetail((current) => (current ? { ...current, chat: { ...current.chat, aiMode: mode } } : current));
      }
    } catch (err) {
      if (targetChatId === chatId) setModeError(err instanceof Error ? err.message : 'Failed to update AI mode.');
    } finally {
      if (targetChatId === chatId) setSavingMode(false);
    }
  }

  useEffect(() => {
    if (!chatId) return;
    setMessages(null);
    setDetail(null);
    setModeError(null);
    setDraft('');
    setSendError(null);
    void load(chatId);
    void loadDetail(chatId);
    markRead(chatId);
    const timer = setInterval(() => void load(chatId), 6000);
    return () => clearInterval(timer);
  }, [chatId]);

  // The send endpoint returns 202 the instant a send is queued, not once it
  // actually succeeds or fails - real dispatch happens asynchronously.
  // Without this, a genuine failure (WhatsApp disconnected, a rejected
  // send) would be invisible: the composer clears and the message just
  // never appears, with no error shown anywhere. This polls the real
  // outcome in the background so a failure surfaces instead of silently
  // vanishing, without blocking the composer while it waits.
  async function pollOutboundOutcome(currentChatId: string, outboundMessageId: string) {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      let result;
      try {
        result = await api.getOutboundMessage(outboundMessageId);
      } catch {
        return; // Transient poll failure - the message list's own refresh is still the source of truth.
      }
      if (result.status === 'sent') {
        if (chatId === currentChatId) void load(currentChatId);
        return;
      }
      if (result.status === 'failed') {
        if (chatId === currentChatId) setSendError(result.lastError ?? 'Failed to send message.');
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  async function dispatchSend(currentChatId: string, body: SendMessageBody) {
    setSending(true);
    setSendError(null);
    try {
      const { outboundMessage } = await api.sendMessage(currentChatId, body);
      // The real message row lands asynchronously once WhatsApp echoes the
      // send back through the normal sync pipeline - the 6s poll (and any
      // message.new event that arrives sooner) picks it up. A manual
      // refresh right away also catches the case where it was already fast.
      void load(currentChatId);
      void pollOutboundOutcome(currentChatId, outboundMessage.id);
    } catch (err) {
      setSendError(err instanceof Error ? err.message : 'Failed to send message.');
    } finally {
      setSending(false);
    }
  }

  async function handleSendText() {
    const text = draft.trim();
    if (!chatId || !text || sending) return;
    setDraft('');
    await dispatchSend(chatId, { messageType: 'text', text });
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void handleSendText();
    }
  }

  function readFileAsBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = String(reader.result ?? '');
        // Strip the "data:<mime>;base64," prefix FileReader adds - the API wants raw base64.
        const commaIndex = result.indexOf(',');
        resolve(commaIndex >= 0 ? result.slice(commaIndex + 1) : result);
      };
      reader.onerror = () => reject(reader.error ?? new Error('Failed to read file'));
      reader.readAsDataURL(file);
    });
  }

  function messageTypeForMime(mimeType: string): 'image' | 'video' | 'audio' | 'document' {
    if (mimeType.startsWith('image/')) return 'image';
    if (mimeType.startsWith('video/')) return 'video';
    if (mimeType.startsWith('audio/')) return 'audio';
    return 'document';
  }

  async function handleFileSelected(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = ''; // Allow re-selecting the same file later.
    if (!file || !chatId || sending) return;

    try {
      const mediaBase64 = await readFileAsBase64(file);
      await dispatchSend(chatId, {
        messageType: messageTypeForMime(file.type || 'application/octet-stream'),
        mediaBase64,
        mediaMimeType: file.type || 'application/octet-stream',
        mediaFileName: file.name,
      });
    } catch (err) {
      setSendError(err instanceof Error ? err.message : 'Failed to read the selected file.');
    }
  }

  useWhatsAppSync((event: RealtimeEvent) => {
    if (!chatId) return;
    if (
      (event.type === 'message.new' ||
        event.type === 'message.status' ||
        event.type === 'media.updated' ||
        event.type === 'message.reaction') &&
      event.chatId === chatId
    ) {
      void load(chatId);
      // A new message arriving while this chat is already open was seen
      // immediately - it should never sit in the unread badge.
      if (event.type === 'message.new') markRead(chatId);
    }
    if (event.type === 'chat.updated' && event.chatId === chatId) void loadDetail(chatId);
    // Presence is keyed by JID, not chatId - only refresh when it's really this contact.
    if (event.type === 'presence.updated' && detail?.chat.chatJid === event.contactJid) void loadDetail(chatId);
  });

  if (!chatId) {
    return (
      <div className="flex h-full flex-1 flex-col items-center justify-center gap-2 text-fg-muted">
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-accent-soft text-2xl font-bold text-accent">
          W
        </div>
        <p className="text-sm">Select a chat to view messages</p>
      </div>
    );
  }

  const headerName =
    detail?.contact?.displayName ??
    detail?.contact?.pushName ??
    detail?.chat.name ??
    detail?.resolvedPhoneNumber ??
    detail?.chat.chatJid ??
    '';
  const headerSecondary =
    detail?.contact?.phoneNumber ?? detail?.chat.phoneNumber ?? detail?.resolvedPhoneNumber ?? detail?.chat.chatJid ?? '';
  // Real presence.update events only, never inferred - mirrors WhatsApp's own
  // header behavior of showing "online"/"last seen" in place of the phone
  // number when a genuine presence signal exists for this contact.
  const presenceLabel = formatPresence(detail?.presence ?? null);

  return (
    <div className="flex h-full flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-3 border-b border-border-subtle bg-surface-1 px-4 py-3">
        <Link to="/chats" className="text-fg-muted hover:text-fg md:hidden" aria-label="Back to chats">
          <ArrowLeft size={18} aria-hidden />
        </Link>
        {detail ? (
          <>
            <Avatar
              label={headerName}
              size="sm"
              photoUrl={detail.contact?.profilePictureMediaId ? mediaUrl(detail.contact.profilePictureMediaId) : null}
            />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-fg">{headerName}</p>
              {presenceLabel ? (
                <p className={`truncate text-[11px] ${presenceLabel === 'online' ? 'text-success' : 'text-fg-muted'}`}>
                  {presenceLabel}
                </p>
              ) : (
                headerSecondary &&
                headerSecondary !== headerName && (
                  <p className="truncate text-[11px] text-fg-muted">{headerSecondary}</p>
                )
              )}
            </div>
            <AiModeControl mode={detail.chat.aiMode} saving={savingMode} error={modeError} onSelect={handleModeSelect} />
          </>
        ) : (
          <p className="flex-1 text-sm text-fg-secondary">Loading real conversation…</p>
        )}
        <button
          type="button"
          onClick={onOpenDetail}
          className="rounded-md px-2 py-1 text-xs text-fg-muted hover:bg-surface-2 hover:text-fg lg:hidden"
        >
          Details
        </button>
      </div>

      <div className={`flex-1 space-y-2 overflow-y-auto bg-surface-0 px-4 py-4 ${doodleClass}`}>
        {error && <p className="text-xs text-error">{error}</p>}
        {messages === null && !error && <p className="text-xs text-fg-muted">Loading real message history…</p>}
        {messages?.length === 0 && <p className="text-xs text-fg-muted">No messages persisted for this chat yet.</p>}
        {messages?.map((message) => (
          <div key={message.id} className={`flex ${message.fromMe ? 'justify-end' : 'justify-start'}`}>
            <div
              className={`max-w-[75%] rounded-2xl px-3 py-2 text-sm shadow-sm ${
                message.fromMe ? 'rounded-tr-sm bg-message-out text-message-out-fg' : 'rounded-tl-sm bg-message-in text-fg'
              }`}
            >
              {message.hasMedia && message.media ? (
                <div className="space-y-1">
                  <MediaContent media={message.media} caption={message.caption} />
                  {(message.caption ?? message.textContent) && (
                    <p className="whitespace-pre-wrap break-words">{message.caption ?? message.textContent}</p>
                  )}
                </div>
              ) : (
                <p className="whitespace-pre-wrap break-words">{messageBody(message)}</p>
              )}
              {message.reactions.length > 0 && (
                <div className="mt-1 flex flex-wrap gap-1">
                  {groupReactions(message.reactions).map(({ emoji, count }) => (
                    <span
                      key={emoji}
                      className="rounded-full bg-black/20 px-1.5 py-0.5 text-[11px] leading-none"
                    >
                      {emoji}
                      {count > 1 ? ` ${count}` : ''}
                    </span>
                  ))}
                </div>
              )}
              <div className="mt-1 flex items-center justify-end gap-1 text-[10px] opacity-80">
                {message.isHistorical && <span title="Synced from history">history</span>}
                {message.aiGenerated && (
                  <span title="Sent by AI" className="flex items-center">
                    <Bot size={11} strokeWidth={2} aria-hidden />
                  </span>
                )}
                <span>{formatTime(message.timestamp)}</span>
                {message.fromMe && <DeliveryTicks status={message.status} />}
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="shrink-0 border-t border-border-subtle bg-surface-1 p-3">
        {sendError && <p className="mb-2 text-xs text-error">{sendError}</p>}
        <div className="flex items-center gap-2 rounded-xl border border-border-subtle bg-surface-2 px-3 py-2 transition-colors focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/20">
          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            onChange={(event) => void handleFileSelected(event)}
          />
          <button
            type="button"
            disabled={sending}
            onClick={() => fileInputRef.current?.click()}
            title="Attach a file"
            className="text-fg-muted hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Paperclip size={18} strokeWidth={1.75} aria-hidden />
          </button>
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={handleComposerKeyDown}
            disabled={sending}
            placeholder="Type a message"
            className="flex-1 bg-transparent text-sm text-fg outline-none placeholder:text-fg-muted disabled:opacity-50"
          />
          <button
            type="button"
            disabled={sending || !draft.trim()}
            onClick={() => void handleSendText()}
            title="Send"
            className={`disabled:cursor-not-allowed disabled:opacity-50 ${
              draft.trim() ? 'text-accent hover:text-accent-dim' : 'text-fg-muted hover:text-fg'
            }`}
          >
            {sending ? (
              <Loader2 size={18} strokeWidth={1.75} className="animate-spin" aria-hidden />
            ) : (
              <Send size={18} strokeWidth={1.75} aria-hidden />
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
