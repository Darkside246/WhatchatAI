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
  SmilePlus,
  Sparkles,
  Lock,
  Trash2,
  Mic,
  Square,
} from 'lucide-react';
import {
  api,
  mediaUrl,
  ApiError,
  type WorkspaceMessage,
  type WorkspaceMedia,
  type WorkspaceChatDetail,
  type WorkspacePresence,
  type SendMessageBody,
  type MemberDto,
  type TeamDto,
} from '../lib/api.js';
import { useWhatsAppSync, type RealtimeEvent } from '../hooks/useWhatsAppSync.js';
import { formatIdentityFallback } from '../lib/identity.js';
import { useTheme } from '../hooks/useTheme.js';
import { THEMES } from '../theme.js';
import { Avatar } from './Avatar.js';
import { MediaLightbox } from './MediaLightbox.js';
import { useVoiceRecorder } from '../hooks/useVoiceRecorder.js';

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
      <div className="flex items-center gap-0.5 rounded-full border border-border-subtle bg-surface-2 p-0.5 text-meta font-medium">
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
      {saving && <span className="text-meta text-fg-muted">Saving…</span>}
      {!saving && mode === 'AI_PAUSED' && <span className="text-meta text-warning">AI Paused</span>}
      {!saving && error && <span className="text-meta text-error">{error}</span>}
    </div>
  );
}

/**
 * Real human-to-human conversation assignment - a separate axis from
 * AiModeControl's AI-vs-human toggle. Every change calls the real
 * assignment API (which enforces real agent capacity server-side); a
 * capacity rejection is shown honestly rather than silently reverted.
 */
function AssigneeControl({
  assigneeUserId,
  assigneeTeamId,
  members,
  teams,
  saving,
  error,
  onSelect,
}: {
  assigneeUserId: string | null;
  assigneeTeamId: string | null;
  members: MemberDto[];
  teams: TeamDto[];
  saving: boolean;
  error: string | null;
  onSelect: (input: { assigneeUserId: string | null; assigneeTeamId: string | null }) => void;
}) {
  const value = assigneeUserId ? `user:${assigneeUserId}` : assigneeTeamId ? `team:${assigneeTeamId}` : '';

  function handleChange(event: ChangeEvent<HTMLSelectElement>) {
    const raw = event.target.value;
    if (!raw) return onSelect({ assigneeUserId: null, assigneeTeamId: null });
    const [kind, id] = raw.split(':');
    if (kind === 'user') return onSelect({ assigneeUserId: id ?? null, assigneeTeamId: null });
    if (kind === 'team') return onSelect({ assigneeUserId: null, assigneeTeamId: id ?? null });
  }

  return (
    <div className="hidden shrink-0 flex-col items-end gap-1 md:flex">
      <select
        value={value}
        disabled={saving}
        onChange={handleChange}
        className="rounded-full border border-border-subtle bg-surface-2 px-2.5 py-1 text-meta font-medium text-fg-secondary outline-none focus:border-accent disabled:opacity-50"
      >
        <option value="">Unassigned</option>
        {members.length > 0 && (
          <optgroup label="People">
            {members.map((member) => (
              <option key={member.userId} value={`user:${member.userId}`}>
                {member.displayName}
              </option>
            ))}
          </optgroup>
        )}
        {teams.length > 0 && (
          <optgroup label="Teams">
            {teams.map((team) => (
              <option key={team.id} value={`team:${team.id}`}>
                {team.name}
              </option>
            ))}
          </optgroup>
        )}
      </select>
      {error && <span className="text-meta text-error">{error}</span>}
    </div>
  );
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/**
 * Date separators are derived entirely from each message's real persisted
 * timestamp - "Today"/"Yesterday" are computed against the viewer's own
 * clock, never stored or fabricated.
 */
function dayKey(iso: string): string {
  return new Date(iso).toDateString();
}

function formatDaySeparator(iso: string): string {
  const date = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);

  if (date.toDateString() === today.toDateString()) return 'Today';
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return date.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...(date.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' }),
  });
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

const QUICK_EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🙏', '🔥'];

/**
 * Plain Unicode emoji - no image assets, no external emoji service, and
 * nothing fabricated: these are literal characters inserted into the real
 * draft the composer already sends through the real outbound pipeline.
 */
const EMOJI_CATEGORIES: { label: string; emojis: string[] }[] = [
  {
    label: 'Smileys',
    emojis: ['😀', '😃', '😄', '😁', '😆', '😅', '😂', '🤣', '😊', '😇', '🙂', '😉', '😍', '🥰', '😘', '😋', '😎', '🥳', '🤩', '🥺', '😭', '😤', '😡', '🤯'],
  },
  {
    label: 'Gestures & people',
    emojis: ['👍', '👎', '👏', '🙌', '🤝', '✌️', '🤞', '🤙', '👊', '✊', '👋', '💪', '🙏', '❤️', '🔥', '✨', '🎉', '💯', '🚀'],
  },
  {
    label: 'Objects & food',
    emojis: ['☕', '🍕', '🍔', '🍦', '🏖️', '✈️', '💻', '📱', '📸', '🎮', '💡', '📌', '🔑', '🎁', '🏆', '⚽', '🏀', '🎵', '🎧'],
  },
];

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
function MediaContent({
  media,
  caption,
  onImageClick,
}: {
  media: WorkspaceMedia;
  caption: string | null;
  onImageClick: (url: string, fileName: string | null) => void;
}) {
  // These states render inside either bubble color (outgoing solid-accent or
  // incoming white), so they inherit the bubble's own text color rather than
  // forcing a neutral fg tone that could go illegible against it.
  if (media.downloadStatus === 'pending' || media.downloadStatus === 'downloading') {
    return (
      <div className="flex items-center gap-2 rounded-lg bg-black/10 px-3 py-4 text-caption opacity-90">
        <Loader2 size={16} className="animate-spin" aria-hidden />
        Downloading media…
      </div>
    );
  }
  if (media.downloadStatus === 'unavailable') {
    return (
      <div className="flex items-center gap-2 rounded-lg bg-black/10 px-3 py-4 text-caption opacity-75">
        <ImageOff size={16} aria-hidden />
        This media is no longer available
      </div>
    );
  }
  if (media.downloadStatus === 'failed') {
    return (
      <div className="flex items-center gap-2 rounded-lg bg-black/10 px-3 py-4 text-caption text-error">
        <FileWarning size={16} aria-hidden />
        Media download failed
      </div>
    );
  }

  const url = mediaUrl(media.id);

  if (media.mediaType === 'image' || media.mediaType === 'sticker') {
    return (
      <button type="button" onClick={() => onImageClick(url, media.fileName)} className="block cursor-zoom-in">
        <img src={url} alt={caption ?? 'Image attachment'} className="max-h-72 max-w-full rounded-lg object-contain" />
      </button>
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
      className="flex items-center gap-2 rounded-lg bg-black/10 px-3 py-2 text-caption hover:bg-black/15"
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

/**
 * WhatsApp only offers "delete for everyone" for a limited period after
 * sending, and the server enforces the same window. Mirroring it here means
 * we never offer a button that is guaranteed to be refused.
 */
const DELETE_FOR_EVERYONE_WINDOW_MS = 2 * 24 * 60 * 60 * 1000 + 12 * 60 * 60 * 1000;

function canDeleteForEveryone(timestamp: string): boolean {
  const sentAt = new Date(timestamp).getTime();
  if (Number.isNaN(sentAt)) return false;
  return Date.now() - sentAt <= DELETE_FOR_EVERYONE_WINDOW_MS;
}

/**
 * Deliberately careful wording. We can say WhatsApp was asked, and that it
 * accepted - we cannot say the message is gone from every recipient's phone,
 * so the UI never claims that.
 */
function revokeLabel(message: WorkspaceMessage): string {
  if (message.revokeStatus === 'requested') return 'Asking WhatsApp to delete this for everyone…';
  if (message.revokeStatus === 'revoke_sent') return 'Delete-for-everyone sent to WhatsApp';
  return `Delete failed${message.revokeError ? `: ${message.revokeError}` : ''}`;
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
  const recorder = useVoiceRecorder();
  const [emojiPickerOpen, setEmojiPickerOpen] = useState(false);
  const [replySuggestions, setReplySuggestions] = useState<string[]>([]);
  const [lightbox, setLightbox] = useState<{ url: string; fileName: string | null } | null>(null);
  const [reactionPickerFor, setReactionPickerFor] = useState<string | null>(null);
  const [reactionError, setReactionError] = useState<string | null>(null);
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [members, setMembers] = useState<MemberDto[]>([]);
  const [teams, setTeams] = useState<TeamDto[]>([]);
  const [savingAssignee, setSavingAssignee] = useState(false);
  const [assigneeError, setAssigneeError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    Promise.all([api.listMembers(), api.listTeams()])
      .then(([membersResult, teamsResult]) => {
        setMembers(membersResult.members);
        setTeams(teamsResult.teams);
      })
      .catch(() => undefined);
  }, []);

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

  async function handleAssigneeSelect(input: { assigneeUserId: string | null; assigneeTeamId: string | null }) {
    if (!chatId || !detail || savingAssignee) return;
    const targetChatId = chatId;
    setSavingAssignee(true);
    setAssigneeError(null);
    try {
      const result = await api.assignChat(targetChatId, input);
      if (targetChatId === chatId) {
        setDetail((current) =>
          current
            ? { ...current, chat: { ...current.chat, assigneeUserId: result.chat.assigneeUserId, assigneeTeamId: result.chat.assigneeTeamId } }
            : current,
        );
      }
    } catch (err) {
      if (targetChatId === chatId) setAssigneeError(err instanceof ApiError ? err.message : 'Failed to update assignment.');
    } finally {
      if (targetChatId === chatId) setSavingAssignee(false);
    }
  }

  /**
   * Fire-and-forget the real send; the reaction bubble itself only appears
   * once Baileys' own messages.reaction event round-trips back through
   * ingestion and the realtime 'message.reaction' event reloads this list -
   * never an optimistic local reaction that could disagree with what
   * WhatsApp actually recorded.
   */
  async function handleReact(messageId: string, emoji: string) {
    setReactionPickerFor(null);
    setReactionError(null);
    try {
      await api.sendReaction(messageId, emoji);
    } catch (err) {
      setReactionError(err instanceof Error ? err.message : 'Failed to send reaction.');
    }
  }

  /**
   * Real WhatsApp "delete for everyone". We deliberately do not remove the
   * bubble locally on click: the message is only marked once WhatsApp has
   * actually been asked, and the bubble then reports what we truly know -
   * that the instruction was sent, not that every device dropped it.
   */
  async function handleRevoke(messageId: string) {
    if (!window.confirm('Delete this message for everyone on WhatsApp? Recipients who already read it may still have seen it.')) return;
    setRevokeError(null);
    setRevoking(messageId);
    try {
      await api.revokeMessage(messageId);
      setMessages((current) =>
        current?.map((message) => (message.id === messageId ? { ...message, revokeStatus: 'requested' as const } : message)) ?? current,
      );
    } catch (err) {
      setRevokeError(err instanceof Error ? err.message : 'Could not delete that message.');
    } finally {
      setRevoking(null);
    }
  }

  useEffect(() => {
    if (!chatId) return;
    setMessages(null);
    setDetail(null);
    setModeError(null);
    setDraft('');
    setSendError(null);
    setEmojiPickerOpen(false);
    setReplySuggestions([]);
    setReactionPickerFor(null);
    setReactionError(null);
    void load(chatId);
    void loadDetail(chatId);
    markRead(chatId);
    const timer = setInterval(() => void load(chatId), 6000);
    return () => clearInterval(timer);
  }, [chatId]);

  /**
   * Real Gemini-drafted replies, fetched only when the newest real message
   * came from the customer and the agent hasn't started typing. The endpoint
   * always answers 200 with an honest status, so an "unavailable" outcome
   * (no key configured, nothing usable to reply to) simply leaves the bar
   * hidden rather than showing an error or a canned fallback list.
   */
  useEffect(() => {
    if (!chatId || !messages || messages.length === 0 || draft.trim()) return;
    const newestWithText = messages.find((message) => Boolean(message.textContent));
    if (!newestWithText || newestWithText.fromMe) {
      setReplySuggestions([]);
      return;
    }

    let cancelled = false;
    api
      .getReplySuggestions(chatId)
      .then((result) => {
        if (!cancelled) setReplySuggestions(result.status === 'ok' ? result.suggestions : []);
      })
      .catch(() => {
        // An optional assist must never surface as an error in the thread.
        if (!cancelled) setReplySuggestions([]);
      });
    return () => {
      cancelled = true;
    };
    // Keyed on the newest message so suggestions refresh when the customer
    // replies, not on every 6s poll that returns the same conversation.
  }, [chatId, messages?.[0]?.id]);

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
    setEmojiPickerOpen(false);
    setReplySuggestions([]);
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

  /**
   * Sends the real captured audio as a voice note. The server converts it to
   * Ogg/Opus before anything is stored or queued, so a recording the
   * recipient could not play never becomes a message.
   */
  async function handleStopRecording() {
    const recording = await recorder.stop();
    if (!recording || !chatId) return;

    try {
      const mediaBase64 = await blobToBase64(recording.blob);
      await dispatchSend(chatId, {
        messageType: 'voice_note',
        mediaBase64,
        mediaMimeType: recording.mimeType,
      });
    } catch (err) {
      setSendError(err instanceof Error ? err.message : 'Could not send that voice note.');
    }
  }

  function blobToBase64(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = String(reader.result ?? '');
        const commaIndex = result.indexOf(',');
        resolve(commaIndex >= 0 ? result.slice(commaIndex + 1) : result);
      };
      reader.onerror = () => reject(reader.error ?? new Error('Failed to read the recording'));
      reader.readAsDataURL(blob);
    });
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
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-accent-soft text-display font-bold text-accent">
          W
        </div>
        <p className="text-body">Select a chat to view messages</p>
      </div>
    );
  }

  const headerName =
    detail?.contact?.displayName ??
    detail?.contact?.pushName ??
    detail?.chat.name ??
    detail?.resolvedPhoneNumber ??
    (detail ? formatIdentityFallback(detail.chat.chatJid) : '');
  const headerSecondary = detail?.contact?.phoneNumber ?? detail?.chat.phoneNumber ?? detail?.resolvedPhoneNumber ?? '';
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
            <button
              type="button"
              onClick={() =>
                detail.contact?.profilePictureMediaId &&
                setLightbox({ url: mediaUrl(detail.contact.profilePictureMediaId), fileName: null })
              }
              disabled={!detail.contact?.profilePictureMediaId}
              className="disabled:cursor-default"
              title={detail.contact?.profilePictureMediaId ? 'View photo' : undefined}
            >
              <Avatar
                label={headerName}
                size="sm"
                photoUrl={detail.contact?.profilePictureMediaId ? mediaUrl(detail.contact.profilePictureMediaId) : null}
              />
            </button>
            <div className="min-w-0 flex-1">
              <p className="truncate text-body font-medium text-fg">{headerName}</p>
              {presenceLabel ? (
                <p className={`truncate text-meta ${presenceLabel === 'online' ? 'text-success' : 'text-fg-muted'}`}>
                  {presenceLabel}
                </p>
              ) : (
                headerSecondary &&
                headerSecondary !== headerName && (
                  <p className="truncate text-meta text-fg-muted">{headerSecondary}</p>
                )
              )}
            </div>
            <AssigneeControl
              assigneeUserId={detail.chat.assigneeUserId}
              assigneeTeamId={detail.chat.assigneeTeamId}
              members={members}
              teams={teams}
              saving={savingAssignee}
              error={assigneeError}
              onSelect={handleAssigneeSelect}
            />
            <AiModeControl mode={detail.chat.aiMode} saving={savingMode} error={modeError} onSelect={handleModeSelect} />
          </>
        ) : (
          <p className="flex-1 text-body text-fg-secondary">Loading real conversation…</p>
        )}
        <button
          type="button"
          onClick={onOpenDetail}
          className="rounded-md px-2 py-1 text-caption text-fg-muted hover:bg-surface-2 hover:text-fg lg:hidden"
        >
          Details
        </button>
      </div>

      <div className={`flex-1 space-y-2 overflow-y-auto bg-surface-0 px-4 py-4 ${doodleClass}`}>
        {error && <p className="text-caption text-error">{error}</p>}
        {reactionError && <p className="text-caption text-error">{reactionError}</p>}
        {revokeError && <p className="text-caption text-error">{revokeError}</p>}
        {messages === null && !error && <p className="text-caption text-fg-muted">Loading real message history…</p>}
        {messages?.length === 0 && <p className="text-caption text-fg-muted">No messages persisted for this chat yet.</p>}

        {/*
          The reference design puts WhatsApp's "Messages and calls are
          end-to-end encrypted. No one outside of this chat can read or
          listen." banner here. Repeating that verbatim would be a false
          claim in a shared team inbox: WhatsApp's end-to-end encryption
          terminates at this linked device, and from there messages are
          decrypted, stored (encrypted at rest), and deliberately readable by
          every teammate with access. This says what is actually true
          instead.
        */}
        {messages && messages.length > 0 && (
          <div className="flex justify-center pb-1">
            <span className="flex max-w-md items-center gap-1.5 rounded-lg bg-surface-2 px-3 py-1.5 text-center text-meta text-fg-muted shadow-sm">
              <Lock size={11} className="shrink-0" aria-hidden />
              Encrypted by WhatsApp in transit, stored encrypted here, and readable by your team.
            </span>
          </div>
        )}
        {messages?.map((message, index) => (
          <div key={message.id}>
            {(index === 0 || dayKey(messages[index - 1]!.timestamp) !== dayKey(message.timestamp)) && (
              <div className="flex justify-center py-2">
                <span className="rounded-lg bg-surface-2 px-3 py-1 text-meta font-medium uppercase tracking-wide text-fg-muted shadow-sm">
                  {formatDaySeparator(message.timestamp)}
                </span>
              </div>
            )}
            <div className={`group relative flex ${message.fromMe ? 'justify-end' : 'justify-start'}`}>
            <div
              className={`relative max-w-[75%] rounded-2xl px-3 py-2 text-body shadow-sm ${
                message.fromMe ? 'rounded-tr-sm bg-message-out text-message-out-fg' : 'rounded-tl-sm bg-message-in text-fg'
              }`}
            >
              <button
                type="button"
                onClick={() => setReactionPickerFor((current) => (current === message.id ? null : message.id))}
                title="React"
                className={`absolute -top-3 z-10 rounded-full border border-border-subtle bg-surface-1 p-1 text-fg-secondary opacity-0 shadow-sm transition-opacity hover:text-fg group-hover:opacity-100 ${
                  message.fromMe ? '-left-3' : '-right-3'
                }`}
              >
                <SmilePlus size={13} aria-hidden />
              </button>

              {message.fromMe && message.revokeStatus === 'none' && canDeleteForEveryone(message.timestamp) && (
                <button
                  type="button"
                  onClick={() => void handleRevoke(message.id)}
                  disabled={revoking === message.id}
                  title="Delete for everyone on WhatsApp"
                  className="absolute -top-3 -left-11 z-10 rounded-full border border-border-subtle bg-surface-1 p-1 text-fg-secondary opacity-0 shadow-sm transition-opacity hover:text-error disabled:opacity-50 group-hover:opacity-100"
                >
                  {revoking === message.id ? <Loader2 size={13} className="animate-spin" aria-hidden /> : <Trash2 size={13} aria-hidden />}
                </button>
              )}

              {reactionPickerFor === message.id && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setReactionPickerFor(null)} />
                  <div
                    className={`absolute -top-11 z-20 flex items-center gap-1 rounded-full border border-border-subtle bg-surface-1 px-2 py-1 shadow-lg ${
                      message.fromMe ? 'right-0' : 'left-0'
                    }`}
                  >
                    {QUICK_EMOJIS.map((emoji) => (
                      <button
                        key={emoji}
                        type="button"
                        onClick={() => void handleReact(message.id, emoji)}
                        className="rounded-full p-0.5 text-body-lg transition-transform hover:scale-125"
                      >
                        {emoji}
                      </button>
                    ))}
                  </div>
                </>
              )}

              {message.hasMedia && message.media ? (
                <div className="space-y-1">
                  <MediaContent
                    media={message.media}
                    caption={message.caption}
                    onImageClick={(url, fileName) => setLightbox({ url, fileName })}
                  />
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
                      className="rounded-full bg-black/20 px-1.5 py-0.5 text-meta leading-none"
                    >
                      {emoji}
                      {count > 1 ? ` ${count}` : ''}
                    </span>
                  ))}
                </div>
              )}
              {message.revokeStatus !== 'none' && (
                <p className="mt-1 flex items-center gap-1 text-meta italic opacity-80">
                  <Trash2 size={10} aria-hidden />
                  {revokeLabel(message)}
                </p>
              )}
              <div className="mt-1 flex items-center justify-end gap-1 text-meta opacity-80">
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
          </div>
        ))}
      </div>

      {replySuggestions.length > 0 && (
        <div className="flex shrink-0 items-center gap-2 overflow-x-auto border-t border-border-subtle bg-surface-2/60 px-4 py-2">
          <span className="flex shrink-0 items-center gap-1.5 text-meta font-semibold text-accent">
            <Sparkles size={13} aria-hidden />
            <span className="hidden sm:inline">AI drafts</span>
          </span>
          {replySuggestions.map((suggestion) => (
            <button
              key={suggestion}
              type="button"
              onClick={() => {
                setDraft(suggestion);
                setReplySuggestions([]);
              }}
              className="shrink-0 whitespace-nowrap rounded-full border border-border-subtle bg-surface-1 px-3 py-1.5 text-caption text-fg-secondary shadow-sm transition-colors hover:border-accent hover:text-accent"
            >
              {suggestion}
            </button>
          ))}
        </div>
      )}

      <div className="relative shrink-0 border-t border-border-subtle bg-surface-1 p-3">
        {sendError && <p className="mb-2 text-caption text-error">{sendError}</p>}

        {emojiPickerOpen && (
          <div
            role="dialog"
            aria-label="Insert emoji"
            className="absolute bottom-full left-3 z-30 mb-2 max-h-72 w-[min(20rem,calc(100vw-1.5rem))] overflow-y-auto rounded-xl border border-border-subtle bg-surface-2 p-3 shadow-2xl"
          >
            {EMOJI_CATEGORIES.map((category) => (
              <div key={category.label} className="mb-3 last:mb-0">
                <p className="mb-1.5 text-meta font-semibold text-fg-muted">{category.label}</p>
                <div className="grid grid-cols-8 gap-1">
                  {category.emojis.map((emoji) => (
                    <button
                      key={emoji}
                      type="button"
                      aria-label={`Insert ${emoji}`}
                      onClick={() => setDraft((previous) => previous + emoji)}
                      className="rounded p-1 text-title transition-transform hover:scale-125 hover:bg-surface-3"
                    >
                      {emoji}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

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
            onClick={() => setEmojiPickerOpen((open) => !open)}
            aria-label="Insert emoji"
            aria-expanded={emojiPickerOpen}
            className={`disabled:cursor-not-allowed disabled:opacity-50 ${emojiPickerOpen ? 'text-accent' : 'text-fg-muted hover:text-fg'}`}
          >
            <SmilePlus size={18} strokeWidth={1.75} aria-hidden />
          </button>
          <button
            type="button"
            disabled={sending || recorder.state === 'recording'}
            onClick={() => fileInputRef.current?.click()}
            title="Attach a file"
            className="text-fg-muted hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Paperclip size={18} strokeWidth={1.75} aria-hidden />
          </button>
          {recorder.state === 'recording' ? (
            /* Real elapsed time from the recorder, and a discard that really
               drops the audio rather than sending a silent note. */
            <div className="flex flex-1 items-center gap-2">
              <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-error" aria-hidden />
              <span className="text-body tabular-nums text-fg">
                {Math.floor(recorder.elapsedSeconds / 60)}:{String(recorder.elapsedSeconds % 60).padStart(2, '0')}
              </span>
              <span className="text-caption text-fg-muted">Recording…</span>
              <button
                type="button"
                onClick={recorder.cancel}
                title="Discard this recording"
                className="ml-auto text-fg-muted hover:text-error"
              >
                <Trash2 size={17} strokeWidth={1.75} aria-hidden />
              </button>
            </div>
          ) : (
            <input
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={handleComposerKeyDown}
              disabled={sending}
              placeholder="Type a message"
              className="flex-1 bg-transparent text-body text-fg outline-none placeholder:text-fg-muted disabled:opacity-50"
            />
          )}
          {recorder.state === 'recording' ? (
            <button
              type="button"
              onClick={() => void handleStopRecording()}
              title="Send voice note"
              className="text-accent hover:text-accent-dim"
            >
              <Square size={18} strokeWidth={1.75} fill="currentColor" aria-hidden />
            </button>
          ) : !draft.trim() ? (
            <button
              type="button"
              disabled={sending || recorder.state === 'requesting'}
              onClick={() => void recorder.start()}
              title="Record a voice note"
              className="text-fg-muted hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
            >
              {recorder.state === 'requesting' ? (
                <Loader2 size={18} strokeWidth={1.75} className="animate-spin" aria-hidden />
              ) : (
                <Mic size={18} strokeWidth={1.75} aria-hidden />
              )}
            </button>
          ) : (
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
          )}
        </div>
        {recorder.error && <p className="mt-1 px-2 text-meta text-error">{recorder.error}</p>}
      </div>

      {lightbox && (
        <MediaLightbox imageUrl={lightbox.url} fileName={lightbox.fileName} onClose={() => setLightbox(null)} />
      )}
    </div>
  );
}
