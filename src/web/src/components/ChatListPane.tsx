import { useEffect, useState } from 'react';
import { NavLink, useSearchParams } from 'react-router-dom';
import { api, mediaUrl, type WorkspaceChatSummary } from '../lib/api.js';
import { useWhatsAppSync, type RealtimeEvent } from '../hooks/useWhatsAppSync.js';
import { Pin, Mic, Image as ImageIcon, Video, FileText, Sticker, MapPin, UserSquare, Archive } from 'lucide-react';
import { Avatar } from './Avatar.js';
import { MediaLightbox } from './MediaLightbox.js';

const AI_MODE_DOT: Record<WorkspaceChatSummary['aiMode'], string> = {
  AI_ACTIVE: 'bg-accent',
  AI_PAUSED: 'bg-warning',
  HUMAN_TAKEOVER: 'bg-info',
};

/**
 * The exact same HIGH/MEDIUM unread-count thresholds
 * securityAlertService.ts's urgencyFromUnreadCount() uses for the alert
 * panel, so a chat's border color and its alert-panel entry are always the
 * same color for the same reason - AlertNotifier.tsx uses border-error/
 * bg-error for HIGH and border-warning/bg-warning for MEDIUM, matched here.
 * Derived from the chat's own live aiMode/unreadCount, not any local
 * "alert dismissed" state, so the marker genuinely tracks the real
 * condition - it clears the moment the chat leaves HUMAN_TAKEOVER or its
 * unread count drops, not because a notification happened to be dismissed
 * in this browser tab.
 */
function chatUrgency(chat: WorkspaceChatSummary): 'HIGH' | 'MEDIUM' | null {
  if (chat.aiMode !== 'HUMAN_TAKEOVER') return null;
  if (chat.unreadCount >= 5) return 'HIGH';
  if (chat.unreadCount >= 2) return 'MEDIUM';
  return null;
}

const URGENCY_ROW_CLASS: Record<'HIGH' | 'MEDIUM', string> = {
  HIGH: 'border-l-4 border-l-error bg-error/5',
  MEDIUM: 'border-l-4 border-l-warning bg-warning/5',
};

// "success" is reserved for live/online/connected signals - kept distinct
// from "accent" (the brand/interactive color used for buttons and selection).

type FilterPill = 'all' | 'unread' | 'groups' | 'needsHuman';

const FILTER_PILLS: { value: FilterPill; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'unread', label: 'Unread' },
  { value: 'groups', label: 'Groups' },
  { value: 'needsHuman', label: 'Needs human' },
];

function isFilterPill(value: string | null): value is FilterPill {
  return value === 'all' || value === 'unread' || value === 'groups' || value === 'needsHuman';
}

/**
 * Maps the real persisted message_type of the last message to its icon.
 * Anything without a genuine icon (plain text, or a type we do not model)
 * simply gets none - never a stand-in glyph implying media that is not
 * actually there.
 */
const LAST_MESSAGE_ICON: Record<string, typeof Mic> = {
  image: ImageIcon,
  video: Video,
  audio: Mic,
  voice_note: Mic,
  document: FileText,
  sticker: Sticker,
  location: MapPin,
  contact: UserSquare,
};

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


/**
 * One conversation row. Extracted so the active and archived sections render
 * identically - the only difference between them is the real is_archived
 * flag that decides which list a chat lands in.
 */
function ChatRow({
  chat,
  onOpenPhoto,
}: {
  chat: WorkspaceChatSummary;
  onOpenPhoto: (url: string) => void;
}) {
  const MediaIcon = chat.lastMessageType ? LAST_MESSAGE_ICON[chat.lastMessageType] : undefined;
  const urgency = chatUrgency(chat);

  return (
    <NavLink
      to={`/chats/${chat.id}`}
      title={urgency === 'HIGH' ? 'Urgent - needs human attention' : urgency === 'MEDIUM' ? 'Needs attention' : undefined}
      className={({ isActive }) =>
        `flex w-full items-center gap-3 border-b border-r-4 border-border-subtle/60 px-4 py-3 text-left transition-colors ${
          isActive ? 'border-r-accent bg-accent-soft' : `border-r-transparent hover:bg-surface-2 ${urgency ? URGENCY_ROW_CLASS[urgency] : ''}`
        }`
      }
    >
      <span
        role="button"
        tabIndex={chat.avatarMediaId ? 0 : -1}
        title={chat.avatarMediaId ? 'View photo' : undefined}
        onClick={(event) => {
          if (!chat.avatarMediaId) return;
          event.preventDefault();
          event.stopPropagation();
          onOpenPhoto(mediaUrl(chat.avatarMediaId));
        }}
      >
        <Avatar
          label={chat.displayName}
          statusCount={chat.activeStatusCount}
          photoUrl={chat.avatarMediaId ? mediaUrl(chat.avatarMediaId) : null}
        />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <p className="truncate text-body font-medium text-fg">{chat.displayName}</p>
          <span className="shrink-0 text-meta text-fg-muted">{formatTime(chat.lastMessageAt)}</span>
        </div>
        <div className="mt-0.5 flex items-center gap-1.5">
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${AI_MODE_DOT[chat.aiMode]}`} />
          {MediaIcon && <MediaIcon size={12} className="shrink-0 text-fg-muted" aria-hidden />}
          <p className="truncate text-caption text-fg-muted">{chat.lastMessagePreview ?? 'No messages yet'}</p>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {chat.isPinned && <Pin size={12} className="text-fg-muted" aria-label="Pinned" />}
        {chat.unreadCount > 0 && (
          <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-unread px-1.5 text-meta font-semibold text-white">
            {chat.unreadCount}
          </span>
        )}
      </div>
    </NavLink>
  );
}

export function ChatListPane({ className = '' }: Props) {
  const [chats, setChats] = useState<WorkspaceChatSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  // Initialized from ?filter=needsHuman (or any other pill value) so a link
  // from elsewhere in the app - the Dashboard's "needs human" widgets, most
  // of all - lands directly on the filtered view instead of the unfiltered
  // full list, which the operator would otherwise have to hunt through by
  // hand to find the 1-2 chats actually being pointed at.
  const [searchParams, setSearchParams] = useSearchParams();
  const initialFilter = searchParams.get('filter');
  const [filter, setFilterState] = useState<FilterPill>(isFilterPill(initialFilter) ? initialFilter : 'all');
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);

  function setFilter(next: FilterPill) {
    setFilterState(next);
    setSearchParams(next === 'all' ? {} : { filter: next }, { replace: true });
  }

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
      if (filter === 'needsHuman') return chat.aiMode === 'HUMAN_TAKEOVER';
      return true;
    });

  // Pinned first, mirroring WhatsApp's own ordering - driven by the real
  // is_pinned flag synced from the connected account, never a local
  // preference invented here. Archived chats are split out entirely rather
  // than being sorted among the active ones.
  const active = filtered
    .filter((chat) => !chat.isArchived)
    .slice()
    .sort((a, b) => Number(b.isPinned) - Number(a.isPinned));
  const archived = filtered.filter((chat) => chat.isArchived);

  return (
    <div className={`h-full flex-col ${className}`}>
      <div className="shrink-0 border-b border-border-subtle p-4">
        <div className="flex items-center justify-between">
          <h1 className="text-body-lg font-semibold text-fg">Chats</h1>
          <span
            title={connected ? 'Live updates connected' : 'Live updates unavailable - showing periodically refreshed data'}
            className={`h-1.5 w-1.5 rounded-full ${connected ? 'bg-success' : 'bg-fg-muted/50'}`}
          />
        </div>
        <input
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search or start a new chat"
          className="mt-3 w-full rounded-lg border border-border-subtle bg-surface-2 px-3 py-2 text-body text-fg placeholder:text-fg-muted focus:border-accent focus:outline-none"
        />
        <div className="mt-3 flex gap-1.5">
          {FILTER_PILLS.map((pill) => (
            <button
              key={pill.value}
              type="button"
              onClick={() => setFilter(pill.value)}
              className={`rounded-full px-3 py-1 text-caption font-medium transition-colors ${
                filter === pill.value ? 'bg-accent-soft text-accent' : 'bg-surface-2 text-fg-secondary hover:bg-surface-3'
              }`}
            >
              {pill.label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {error && <p className="p-4 text-caption text-error">{error}</p>}
        {chats && chats.length === 0 && (
          <p className="p-4 text-body text-fg-muted">No conversations yet. Real chats will appear here as WhatsApp syncs.</p>
        )}
        {chats && chats.length > 0 && filtered.length === 0 && (
          <p className="p-4 text-body text-fg-muted">No chats match this filter.</p>
        )}
        {active.map((chat) => (
          <ChatRow key={chat.id} chat={chat} onOpenPhoto={setLightboxUrl} />
        ))}

        {archived.length > 0 && (
          <>
            <div className="flex items-center gap-2 border-b border-border-subtle/60 bg-surface-2/50 px-4 py-2">
              <Archive size={13} className="text-fg-muted" aria-hidden />
              <span className="text-caption font-medium text-fg-secondary">Archived</span>
              <span className="text-meta text-fg-muted">{archived.length}</span>
            </div>
            {archived.map((chat) => (
              <ChatRow key={chat.id} chat={chat} onOpenPhoto={setLightboxUrl} />
            ))}
          </>
        )}
      </div>

      {lightboxUrl && <MediaLightbox imageUrl={lightboxUrl} fileName={null} onClose={() => setLightboxUrl(null)} />}
    </div>
  );
}
