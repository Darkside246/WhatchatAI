import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  Archive, ArchiveRestore, BellOff, Bell, ChevronRight, Eraser, Heart, HeartOff, ListPlus, MailOpen, Pin, PinOff, Trash2,
} from 'lucide-react';
import { api, ApiError, type WorkspaceChatSummary } from '../lib/api.js';

/**
 * Right-click on a conversation.
 *
 * Everything on this menu is local to AURA. Nothing is sent to WhatsApp,
 * nobody is blocked, and the customer's own app is untouched by any of it -
 * which is why the destructive two say so in their confirmation rather than
 * leaving somebody to assume the worst or, worse, the best.
 *
 * There is deliberately no Block. A real WhatsApp block changes the
 * business's own account, and an item on this menu labelled "Block" that
 * quietly did something else would be the one lie people would trust.
 */

export interface ChatContextMenuProps {
  chat: WorkspaceChatSummary;
  /** Where the pointer was. The menu positions itself here and then nudges itself back on screen. */
  x: number;
  y: number;
  onClose: () => void;
  /** Refetch the list - every action changes something the list shows. */
  onChanged: () => void;
  /** Opens the existing Lists picker for this chat, which is a screen of its own rather than a submenu. */
  onAddToList?: (chat: WorkspaceChatSummary) => void;
}

/** WhatsApp's own durations, which is what people expect this menu to offer. */
const MUTE_OPTIONS: { label: string; hours: number }[] = [
  { label: '8 hours', hours: 8 },
  { label: '1 week', hours: 24 * 7 },
  { label: 'Always', hours: 0 },
];

function isMuted(chat: WorkspaceChatSummary): boolean {
  return chat.mutedUntil !== null && new Date(chat.mutedUntil).getTime() > Date.now();
}

export function ChatContextMenu({ chat, x, y, onClose, onChanged, onAddToList }: ChatContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ x, y });
  const [muteOpen, setMuteOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Nudged back on screen after measuring.
   *
   * A menu opened near the bottom right otherwise renders half off the
   * viewport, and the items people reach for most - the destructive ones,
   * which sit last - are exactly the ones that fall off.
   */
  useLayoutEffect(() => {
    const element = menuRef.current;
    if (!element) return;
    const { width, height } = element.getBoundingClientRect();
    setPosition({
      x: Math.max(8, Math.min(x, window.innerWidth - width - 8)),
      y: Math.max(8, Math.min(y, window.innerHeight - height - 8)),
    });
  }, [x, y]);

  useEffect(() => {
    function onPointerDown(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) onClose();
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKey);
    // A menu anchored to a point in the list has to go when the list moves
    // under it, or it points at a different conversation than the one it
    // was opened on.
    window.addEventListener('scroll', onClose, true);
    window.addEventListener('resize', onClose);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onClose, true);
      window.removeEventListener('resize', onClose);
    };
  }, [onClose]);

  async function run(action: () => Promise<unknown>, closeAfter = true) {
    setBusy(true);
    setError(null);
    try {
      await action();
      onChanged();
      if (closeAfter) onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not do that.');
    } finally {
      setBusy(false);
    }
  }

  const muted = isMuted(chat);

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label={`Options for ${chat.displayName}`}
      style={{ left: position.x, top: position.y }}
      className="fixed z-50 w-60 overflow-hidden rounded-xl border border-border-subtle bg-surface-1 py-1 shadow-lg"
    >
      {error && <p className="mx-1 mb-1 rounded bg-error/10 px-2 py-1 text-meta text-error">{error}</p>}

      <Item
        icon={chat.archived ? ArchiveRestore : Archive}
        label={chat.archived ? 'Unarchive chat' : 'Archive chat'}
        disabled={busy}
        onClick={() => void run(() => api.setChatArchived(chat.id, !chat.archived))}
      />

      {/* A submenu, because "mute" without "for how long" is the question
          everybody asks next. */}
      <div className="relative">
        <Item
          icon={muted ? Bell : BellOff}
          label={muted ? 'Unmute notifications' : 'Mute notifications'}
          disabled={busy}
          trailing={muted ? undefined : <ChevronRight size={13} aria-hidden />}
          onClick={() => (muted ? void run(() => api.setChatMuted(chat.id, null)) : setMuteOpen((open) => !open))}
        />
        {muteOpen && !muted && (
          <div className="mb-1 ml-7 mr-1 rounded-lg bg-surface-2 py-1">
            {MUTE_OPTIONS.map((option) => (
              <button
                key={option.label}
                type="button"
                role="menuitem"
                disabled={busy}
                onClick={() => void run(() => api.setChatMuted(chat.id, option.hours))}
                className="block w-full px-3 py-1.5 text-left text-caption text-fg hover:bg-surface-3 disabled:opacity-50"
              >
                {option.label}
              </button>
            ))}
          </div>
        )}
      </div>

      <Item
        icon={chat.pinned ? PinOff : Pin}
        label={chat.pinned ? 'Unpin chat' : 'Pin chat'}
        disabled={busy}
        onClick={() => void run(() => api.setChatPinned(chat.id, !chat.pinned))}
      />

      {/* Only offered where it means something. A conversation that already
          has unread messages is unread, and an item that would visibly do
          nothing is an item that teaches people the menu is broken. */}
      {chat.unreadCount === 0 && (
        <Item
          icon={MailOpen}
          label={chat.markedUnread ? 'Mark as read' : 'Mark as unread'}
          disabled={busy}
          onClick={() => void run(() => api.setChatMarkedUnread(chat.id, !chat.markedUnread))}
        />
      )}

      <Item
        icon={chat.favorite ? HeartOff : Heart}
        label={chat.favorite ? 'Remove from Favorites' : 'Add to Favorites'}
        disabled={busy}
        onClick={() => void run(() => api.setChatFavorite(chat.id, !chat.favorite))}
      />

      {onAddToList && (
        <Item
          icon={ListPlus}
          label="Add to list"
          disabled={busy}
          trailing={<ChevronRight size={13} aria-hidden />}
          onClick={() => {
            onAddToList(chat);
            onClose();
          }}
        />
      )}

      <div className="my-1 border-t border-border-subtle" />

      {/* The two that destroy something. Separated by a rule and worded so
          nobody can mistake what they reach: this workspace, not WhatsApp. */}
      <Item
        icon={Eraser}
        label="Clear chat"
        destructive
        disabled={busy}
        onClick={() => {
          if (
            !window.confirm(
              `Clear the messages in ${chat.displayName}?\n\nThis empties the conversation in AURA only. WhatsApp still has every message and the customer's phone is untouched.`,
            )
          ) {
            return;
          }
          void run(async () => {
            const { cleared } = await api.clearChat(chat.id);
            if (cleared === 0) setError('There was nothing to clear.');
          });
        }}
      />

      <Item
        icon={Trash2}
        label="Delete chat"
        destructive
        disabled={busy}
        onClick={() => {
          if (
            !window.confirm(
              `Remove ${chat.displayName} from AURA?\n\nIt disappears from your inbox here. The conversation still exists on WhatsApp, and if they write again it comes back.`,
            )
          ) {
            return;
          }
          void run(() => api.deleteChat(chat.id));
        }}
      />
    </div>
  );
}

function Item({
  icon: Icon,
  label,
  onClick,
  disabled,
  destructive,
  trailing,
}: {
  icon: typeof Archive;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  destructive?: boolean;
  trailing?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      className={`flex w-full items-center gap-2.5 px-3 py-2 text-left text-caption disabled:opacity-50 ${
        destructive ? 'text-error hover:bg-error/10' : 'text-fg hover:bg-surface-2'
      }`}
    >
      <Icon size={15} className="shrink-0" aria-hidden />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {trailing}
    </button>
  );
}
