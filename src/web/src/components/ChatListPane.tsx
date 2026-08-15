import { useEffect, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { api, type WorkspaceChatSummary } from '../lib/api.js';

const AI_MODE_DOT: Record<WorkspaceChatSummary['aiMode'], string> = {
  AI_ACTIVE: 'bg-emerald-400',
  AI_PAUSED: 'bg-amber-400',
  HUMAN_TAKEOVER: 'bg-sky-400',
};

function formatTime(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

interface Props {
  className?: string;
}

export function ChatListPane({ className = '' }: Props) {
  const [chats, setChats] = useState<WorkspaceChatSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function load() {
      try {
        const { chats: list } = await api.listChats();
        if (!cancelled) {
          setChats(list);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load chats.');
      } finally {
        if (!cancelled) timer = setTimeout(load, 5000);
      }
    }

    void load();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);

  const filtered = (chats ?? []).filter((chat) => chat.displayName.toLowerCase().includes(search.toLowerCase()));

  return (
    <div className={`h-full flex-col ${className}`}>
      <div className="shrink-0 border-b border-border-subtle p-4">
        <h1 className="text-base font-semibold text-white">Chats</h1>
        <input
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search conversations"
          className="mt-3 w-full rounded-lg border border-border-subtle bg-surface-2 px-3 py-2 text-sm text-gray-200 placeholder:text-gray-500 focus:border-emerald-500 focus:outline-none"
        />
      </div>

      <div className="flex-1 overflow-y-auto">
        {error && <p className="p-4 text-xs text-red-400">{error}</p>}
        {chats && chats.length === 0 && (
          <p className="p-4 text-sm text-gray-500">No conversations yet. Real chats will appear here as WhatsApp syncs.</p>
        )}
        {filtered.map((chat) => (
          <NavLink
            key={chat.id}
            to={`/chats/${chat.id}`}
            className={({ isActive }) =>
              `flex w-full items-center gap-3 border-b border-border-subtle/60 px-4 py-3 text-left transition-colors ${
                isActive ? 'bg-surface-2' : 'hover:bg-surface-1'
              }`
            }
          >
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-surface-3 text-sm font-semibold text-gray-300">
              {chat.displayName.slice(0, 1).toUpperCase()}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-2">
                <p className="truncate text-sm font-medium text-white">{chat.displayName}</p>
                <span className="shrink-0 text-[11px] text-gray-500">{formatTime(chat.lastMessageAt)}</span>
              </div>
              <div className="mt-0.5 flex items-center gap-1.5">
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${AI_MODE_DOT[chat.aiMode]}`} />
                <p className="truncate text-xs text-gray-500">{chat.lastMessagePreview ?? 'No messages yet'}</p>
              </div>
            </div>
            {chat.unreadCount > 0 && (
              <span className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-emerald-500 px-1.5 text-[11px] font-semibold text-black">
                {chat.unreadCount}
              </span>
            )}
          </NavLink>
        ))}
      </div>
    </div>
  );
}
