import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, type WorkspaceMessage } from '../lib/api.js';

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function messageBody(message: WorkspaceMessage): string {
  if (message.textContent) return message.textContent;
  if (message.caption) return message.caption;
  if (message.hasMedia) return `[${message.messageType}]`;
  return `[${message.messageType}]`;
}

interface Props {
  onOpenDetail?: () => void;
}

export function ChatThread({ onOpenDetail }: Props) {
  const { chatId } = useParams<{ chatId: string }>();
  const [messages, setMessages] = useState<WorkspaceMessage[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!chatId) return;
    setMessages(null);
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function load() {
      try {
        const { messages: list } = await api.listMessages(chatId!);
        if (!cancelled) {
          setMessages([...list].reverse());
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load messages.');
      } finally {
        if (!cancelled) timer = setTimeout(load, 4000);
      }
    }

    void load();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [chatId]);

  if (!chatId) {
    return (
      <div className="flex h-full flex-1 flex-col items-center justify-center gap-2 text-gray-500">
        <span className="text-4xl">💬</span>
        <p className="text-sm">Select a conversation to view real messages.</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-3 border-b border-border-subtle bg-surface-1 px-4 py-3">
        <Link to="/chats" className="text-gray-400 hover:text-white lg:hidden" aria-label="Back to chats">
          ←
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

      <div className="flex-1 space-y-2 overflow-y-auto bg-surface-0 px-4 py-4">
        {error && <p className="text-xs text-red-400">{error}</p>}
        {messages === null && !error && <p className="text-xs text-gray-500">Loading real message history…</p>}
        {messages?.length === 0 && <p className="text-xs text-gray-500">No messages persisted for this chat yet.</p>}
        {messages?.map((message) => (
          <div key={message.id} className={`flex ${message.fromMe ? 'justify-end' : 'justify-start'}`}>
            <div
              className={`max-w-[75%] rounded-2xl px-3 py-2 text-sm ${
                message.fromMe ? 'bg-emerald-600 text-white' : 'bg-surface-2 text-gray-100'
              }`}
            >
              <p className="whitespace-pre-wrap break-words">{messageBody(message)}</p>
              <div className="mt-1 flex items-center justify-end gap-1 text-[10px] opacity-70">
                {message.isHistorical && <span title="Synced from history">history</span>}
                <span>{formatTime(message.timestamp)}</span>
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="shrink-0 border-t border-border-subtle bg-surface-1 p-3">
        <div className="flex items-center gap-2 rounded-xl border border-border-subtle bg-surface-2 px-3 py-2 opacity-60">
          <input
            disabled
            placeholder="Sending is not built yet (Phase 4 - outbound dispatcher)"
            className="flex-1 bg-transparent text-sm text-gray-400 outline-none"
          />
          <button disabled type="button" className="rounded-lg bg-surface-3 px-3 py-1.5 text-xs text-gray-500">
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
