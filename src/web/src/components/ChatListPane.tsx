import { useEffect, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { api, type WorkspaceChatSummary } from '../lib/api.js';
import { useWhatsAppSync, type RealtimeEvent } from '../hooks/useWhatsAppSync.js';

const AI_MODE_DOT: Record<WorkspaceChatSummary['aiMode'], string> = {
  AI_ACTIVE: 'bg-emerald-400',
  AI_PAUSED: 'bg-amber-400',
  HUMAN_TAKEOVER: 'bg-sky-400',
};

type FilterPill = 'all' | 'unread' | 'groups';

const FILTER_PILLS: { value: FilterPill; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'unread', label: 'Unread' },
  { value: 'groups', label: 'Groups' },
];

function formatTime(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

// Real fallback poll interval - the WebSocket push (useWhatsAppSync) makes
// this rarely the reason a list updates, but it's what keeps the list
// correct if the socket is down.
const FALLBACK_POLL_MS = 8000;

interface Props {
  className?: string;
}

export function ChatListPane({ className = '' }: Props) {
  const [chats, setChats] = useState<WorkspaceChatSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<FilterPill>('all');

  async function load() {
    try {
      const { chats: list } = await api.listChats();
      setChats(list);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load chats.');
    }
  }

  useEffect(() => {
    void load();
    const timer = setInterval(load, FALLBACK_POLL_MS);
    return () => clearInterval(timer);
  }, []);

  const { connected } = useWhatsAppSync((event: RealtimeEvent) => {
    if (event.type === 'chat.updated' || event.type === 'message.new') void load();
  });

  const filtered = (chats ?? [])
    .filter((chat) => chat.displayName.toLowerCase().includes(search.toLowerCase()))
    .filter((chat) => {
      if (filter === 'unread') return chat.unreadCount > 0;
      if (filter === 'groups') return chat.chatType === 'group';
      return true;
    });

  return (
    <div className={`h-full flex-col ${className}`}>
      <div className="shrink-0 border-b border-border-subtle p-4">
        <div className="flex items-center justify-between">
          <h1 className="text-base font-semibold text-white">Chats</h1>
          <span
            title={connected ? 'Live updates connected' : 'Live updates unavailable - showing periodically refreshed data'}
            className={`h-1.5 w-1.5 rounded-full ${connected ? 'bg-emerald-400' : 'bg-gray-600'}`}
          />
        </div>
        <input
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search or start a new chat"
          className="mt-3 w-full rounded-lg border border-border-subtle bg-surface-2 px-3 py-2 text-sm text-gray-200 placeholder:text-gray-500 focus:border-emerald-500 focus:outline-none"
        />
        <div className="mt-3 flex gap-1.5">
          {FILTER_PILLS.map((pill) => (
            <button
              key={pill.value}
              type="button"
              onClick={() => setFilter(pill.value)}
              className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                filter === pill.value
                  ? 'bg-emerald-500/15 text-emerald-400'
                  : 'bg-surface-2 text-gray-400 hover:bg-surface-3'
              }`}
            >
              {pill.label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {error && <p className="p-4 text-xs text-red-400">{error}</p>}
        {chats && chats.length === 0 && (
          <p className="p-4 text-sm text-gray-500">No conversations yet. Real chats will appear here as WhatsApp syncs.</p>
        )}
        {chats && chats.length > 0 && filtered.length === 0 && (
          <p className="p-4 text-sm text-gray-500">No chats match this filter.</p>
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
