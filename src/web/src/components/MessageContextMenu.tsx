import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Copy, Download, Forward, Pin, PinOff, Reply, Star, StarOff, Trash2 } from 'lucide-react';
import { api, ApiError, mediaUrl, type WorkspaceMessage } from '../lib/api.js';

/**
 * Right-click on a message.
 *
 * Modelled on what WhatsApp itself offers, minus the items that would be a
 * lie here:
 *
 *   "Ask Meta AI" is Meta's own assistant inside their client. This app has
 *   its own agent, reached from the composer; an item here with Meta's name
 *   on it would claim something untrue about where the text went.
 *
 *   "Report" reports a message to Meta for review. Nothing in this app can
 *   do that - it would have to be a button that quietly did nothing, or one
 *   that filed a complaint somewhere the person did not intend.
 *
 *   "Share" and "Open with" are operating-system handoffs a web page cannot
 *   perform reliably. Save does the useful half of both.
 *
 * Everything that is here does what its label says, and the two that touch
 * WhatsApp rather than only AURA say so in their confirmation.
 */

export function MessageContextMenu({
  message,
  x,
  y,
  canSend,
  onClose,
  onChanged,
  onReply,
  onForward,
}: {
  message: WorkspaceMessage;
  x: number;
  y: number;
  /** Delete-for-everyone is a real WhatsApp send, so it follows the same permission the composer does. */
  canSend: boolean;
  onClose: () => void;
  onChanged: () => void;
  onReply?: (message: WorkspaceMessage) => void;
  onForward: (message: WorkspaceMessage) => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ x, y });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Nudged back on screen after measuring - a menu opened on the last bubble otherwise renders half below the viewport. */
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
    // Anchored to a point in a thread that scrolls under it - a menu left
    // open while the list moves is pointing at a different message.
    window.addEventListener('scroll', onClose, true);
    window.addEventListener('resize', onClose);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onClose, true);
      window.removeEventListener('resize', onClose);
    };
  }, [onClose]);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      onChanged();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not do that.');
    } finally {
      setBusy(false);
    }
  }

  const starred = Boolean(message.workspaceStarredAt);
  const pinned = Boolean(message.workspacePinnedAt);
  const body = message.textContent ?? message.caption ?? '';
  const fileUrl = message.media ? mediaUrl(message.media.id) : null;
  /** Already recalled, so there is nothing left to recall. */
  const revoked = message.revokeStatus === 'revoke_sent' || message.revokeStatus === 'requested';

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label="Message options"
      style={{ left: position.x, top: position.y }}
      className="fixed z-50 w-52 overflow-hidden rounded-xl border border-border-subtle bg-surface-1 py-1 shadow-lg"
    >
      {error && <p className="mx-1 mb-1 rounded bg-error/10 px-2 py-1 text-meta text-error">{error}</p>}

      {onReply && (
        <Item icon={Reply} label="Reply" disabled={busy} onClick={() => { onReply(message); onClose(); }} />
      )}

      {/* Only where there is text to copy. An item that copies an empty
          string is an item that makes people doubt the clipboard. */}
      {body.trim() && (
        <Item
          icon={Copy}
          label="Copy"
          disabled={busy}
          onClick={() => {
            void navigator.clipboard?.writeText(body).catch(() => setError('This browser would not let us copy that.'));
            onClose();
          }}
        />
      )}

      <Item icon={Forward} label="Forward" disabled={busy} onClick={() => { onForward(message); onClose(); }} />

      <Item
        icon={pinned ? PinOff : Pin}
        label={pinned ? 'Unpin' : 'Pin'}
        disabled={busy}
        onClick={() => void run(() => api.setMessagePinned(message.id, !pinned))}
      />

      <Item
        icon={starred ? StarOff : Star}
        label={starred ? 'Unstar' : 'Star'}
        disabled={busy}
        onClick={() => void run(() => api.setMessageStarred(message.id, !starred))}
      />

      {/* The useful half of "Save as" and "Share": the file itself. */}
      {fileUrl && (
        <Item
          icon={Download}
          label="Save"
          disabled={busy}
          onClick={() => {
            const link = document.createElement('a');
            link.href = fileUrl;
            link.download = message.media?.fileName ?? '';
            link.rel = 'noreferrer';
            document.body.appendChild(link);
            link.click();
            link.remove();
            onClose();
          }}
        />
      )}

      {/* The one item that reaches WhatsApp. Separated by a rule, offered
          only to somebody who can send, and only on our own messages -
          WhatsApp does not let anybody recall a message they did not send,
          so an item here for the customer's messages would simply fail. */}
      {canSend && message.fromMe && !revoked && (
        <>
          <div className="my-1 border-t border-border-subtle" />
          <Item
            icon={Trash2}
            label="Delete for everyone"
            destructive
            disabled={busy}
            onClick={() => {
              if (
                !window.confirm(
                  'Delete this message for everyone?\n\nWhatsApp is asked to remove it from the recipient’s phone too. That usually works, and it is a request rather than a guarantee - anyone who already read it may have seen it.',
                )
              ) {
                return;
              }
              void run(() => api.revokeMessage(message.id));
            }}
          />
        </>
      )}
    </div>
  );
}

function Item({
  icon: Icon,
  label,
  onClick,
  disabled,
  destructive,
}: {
  icon: typeof Copy;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  destructive?: boolean;
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
    </button>
  );
}
