import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Check, CheckCheck, Clock, AlertCircle, Paperclip, Smile, Mic } from 'lucide-react';
import { api, type WorkspaceMessage } from '../lib/api.js';
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
    if ((event.type === 'message.new' || event.type === 'message.status') && event.chatId === chatId) {
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
              <p className="whitespace-pre-wrap break-words">{messageBody(message)}</p>
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
