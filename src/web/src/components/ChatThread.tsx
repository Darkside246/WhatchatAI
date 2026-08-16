import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  ArrowLeft,
  Check,
  CheckCheck,
  Clock,
  AlertCircle,
  Paperclip,
  Smile,
  Mic,
  Download,
  FileText,
  ImageOff,
  Loader2,
  FileWarning,
} from 'lucide-react';
import { api, mediaUrl, type WorkspaceMessage, type WorkspaceMedia } from '../lib/api.js';
import { useWhatsAppSync, type RealtimeEvent } from '../hooks/useWhatsAppSync.js';

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function messageBody(message: WorkspaceMessage): string {
  if (message.textContent) return message.textContent;
  if (message.caption) return message.caption;
  if (message.hasMedia) return `[${message.messageType}]`;
  return `[${message.messageType}]`;
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
  if (media.downloadStatus === 'pending' || media.downloadStatus === 'downloading') {
    return (
      <div className="flex items-center gap-2 rounded-lg bg-black/20 px-3 py-4 text-xs text-gray-300">
        <Loader2 size={16} className="animate-spin" aria-hidden />
        Downloading media…
      </div>
    );
  }
  if (media.downloadStatus === 'unavailable') {
    return (
      <div className="flex items-center gap-2 rounded-lg bg-black/20 px-3 py-4 text-xs text-gray-400">
        <ImageOff size={16} aria-hidden />
        This media is no longer available
      </div>
    );
  }
  if (media.downloadStatus === 'failed') {
    return (
      <div className="flex items-center gap-2 rounded-lg bg-black/20 px-3 py-4 text-xs text-red-400">
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
      className="flex items-center gap-2 rounded-lg bg-black/20 px-3 py-2 text-xs text-gray-100 hover:bg-black/30"
    >
      <FileText size={20} aria-hidden />
      <span className="flex flex-col">
        <span className="font-medium">{media.fileName ?? 'Document'}</span>
        <span className="text-gray-400">{formatFileSize(media.fileSize)}</span>
      </span>
      <Download size={14} className="ml-2 shrink-0" aria-hidden />
    </a>
  );
}

/** Real delivery-receipt ticks driven by message.status (see messages.update wiring) - never a fabricated state. */
function DeliveryTicks({ status }: { status: WorkspaceMessage['status'] }) {
  if (status === 'failed') return <AlertCircle size={13} className="text-red-400" aria-label="Failed to send" />;
  if (status === 'pending') return <Clock size={13} className="text-white/50" aria-label="Pending" />;
  if (status === 'sent') return <Check size={14} className="text-white/60" aria-label="Sent" />;
  if (status === 'delivered') return <CheckCheck size={14} className="text-white/60" aria-label="Delivered" />;
  if (status === 'read' || status === 'played') return <CheckCheck size={14} className="text-sky-300" aria-label="Read" />;
  return null;
}

// WhatsApp-style subtle doodle background, as an inline SVG data URI - no external asset dependency.
const DOODLE_BACKGROUND =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='100' height='100'%3E%3Cg fill='none' stroke='%23ffffff' stroke-opacity='0.035' stroke-width='1.2'%3E%3Ccircle cx='20' cy='20' r='10'/%3E%3Cpath d='M55 15 L70 30 M70 15 L55 30'/%3E%3Crect x='45' y='55' width='16' height='16' rx='3'/%3E%3Cpath d='M10 70 Q20 60 30 70 T50 70'/%3E%3C/g%3E%3C/svg%3E\")";

interface Props {
  onOpenDetail?: () => void;
}

export function ChatThread({ onOpenDetail }: Props) {
  const { chatId } = useParams<{ chatId: string }>();
  const [messages, setMessages] = useState<WorkspaceMessage[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load(currentChatId: string) {
    try {
      const { messages: list } = await api.listMessages(currentChatId);
      setMessages([...list].reverse());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load messages.');
    }
  }

  useEffect(() => {
    if (!chatId) return;
    setMessages(null);
    void load(chatId);
    const timer = setInterval(() => void load(chatId), 6000);
    return () => clearInterval(timer);
  }, [chatId]);

  useWhatsAppSync((event: RealtimeEvent) => {
    if (!chatId) return;
    if (
      (event.type === 'message.new' || event.type === 'message.status' || event.type === 'media.updated') &&
      event.chatId === chatId
    ) {
      void load(chatId);
    }
  });

  if (!chatId) {
    return (
      <div className="flex h-full flex-1 flex-col items-center justify-center gap-2 text-gray-500">
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-emerald-500/10 text-2xl font-bold text-emerald-400">
          W
        </div>
        <p className="text-sm">Select a chat to view messages</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-3 border-b border-border-subtle bg-surface-1 px-4 py-3">
        <Link to="/chats" className="text-gray-400 hover:text-white lg:hidden" aria-label="Back to chats">
          <ArrowLeft size={18} aria-hidden />
        </Link>
        <p className="flex-1 text-sm font-medium text-white">Conversation</p>
        <button
          type="button"
          onClick={onOpenDetail}
          className="rounded-md px-2 py-1 text-xs text-gray-400 hover:bg-surface-2 hover:text-white lg:hidden"
        >
          Details
        </button>
      </div>

      <div className="flex-1 space-y-2 overflow-y-auto bg-surface-0 px-4 py-4" style={{ backgroundImage: DOODLE_BACKGROUND }}>
        {error && <p className="text-xs text-red-400">{error}</p>}
        {messages === null && !error && <p className="text-xs text-gray-500">Loading real message history…</p>}
        {messages?.length === 0 && <p className="text-xs text-gray-500">No messages persisted for this chat yet.</p>}
        {messages?.map((message) => (
          <div key={message.id} className={`flex ${message.fromMe ? 'justify-end' : 'justify-start'}`}>
            <div
              className={`max-w-[75%] rounded-2xl px-3 py-2 text-sm shadow-sm ${
                message.fromMe ? 'bg-emerald-700 text-white' : 'bg-surface-2 text-gray-100'
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
              <div className="mt-1 flex items-center justify-end gap-1 text-[10px] opacity-80">
                {message.isHistorical && <span title="Synced from history">history</span>}
                <span>{formatTime(message.timestamp)}</span>
                {message.fromMe && <DeliveryTicks status={message.status} />}
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="shrink-0 border-t border-border-subtle bg-surface-1 p-3">
        <div className="flex items-center gap-2 rounded-xl border border-border-subtle bg-surface-2 px-3 py-2">
          <button type="button" disabled title="Attach (not built yet)" className="cursor-not-allowed text-gray-600">
            <Paperclip size={18} strokeWidth={1.75} aria-hidden />
          </button>
          <button type="button" disabled title="Emoji (not built yet)" className="cursor-not-allowed text-gray-600">
            <Smile size={18} strokeWidth={1.75} aria-hidden />
          </button>
          <input
            disabled
            placeholder="Sending is not built yet (Phase 4 - outbound dispatcher)"
            className="flex-1 bg-transparent text-sm text-gray-400 outline-none"
          />
          <button type="button" disabled title="Voice message (not built yet)" className="cursor-not-allowed text-gray-600">
            <Mic size={18} strokeWidth={1.75} aria-hidden />
          </button>
        </div>
      </div>
    </div>
  );
}
