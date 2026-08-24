import { useCallback, useEffect, useRef, useState } from 'react';
import { Bell, Check } from 'lucide-react';
import { api, type NotificationDto } from '../lib/api.js';
import { useWhatsAppSync } from '../hooks/useWhatsAppSync.js';
import { useAuth } from '../hooks/useAuth.js';

const SEVERITY_DOT: Record<NotificationDto['severity'], string> = {
  info: 'bg-info',
  warning: 'bg-warning',
  critical: 'bg-error',
};

function formatRelativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const diffMinutes = Math.round(diffMs / 60000);
  if (diffMinutes < 1) return 'just now';
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  const diffHours = Math.round(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.round(diffHours / 24);
  return `${diffDays}d ago`;
}

/**
 * A real, persisted, per-user notification centre - not a UI-only toast
 * feed. Every entry here came from a real backend event (see
 * notificationService.ts) delivered live over the authenticated WebSocket
 * bridge, with REST as the fallback/source of truth on open.
 */
export function NotificationCenter() {
  const auth = useAuth();
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState<NotificationDto[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const result = await api.listNotifications();
      setNotifications(result.notifications);
      setUnreadCount(result.unreadCount);
    } catch {
      // Leave the last-known list in place rather than clearing it on a transient failure.
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useWhatsAppSync(
    useCallback(
      (event) => {
        if (event.type === 'notification.created' && event.userId === auth.user?.id) {
          void load();
        }
      },
      [auth.user?.id, load],
    ),
  );

  useEffect(() => {
    function onClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, []);

  async function handleOpen() {
    setOpen((value) => !value);
  }

  async function handleMarkRead(notification: NotificationDto) {
    if (notification.readAt) return;
    setNotifications((prev) => prev.map((n) => (n.id === notification.id ? { ...n, readAt: new Date().toISOString() } : n)));
    setUnreadCount((count) => Math.max(0, count - 1));
    try {
      await api.markNotificationRead(notification.id);
    } catch {
      await load();
    }
  }

  /** Clears the visible list, not just the unread highlight - the backend dismisses every currently-listed notification, keeping the underlying rows as real history rather than deleting them. */
  async function handleMarkAllRead() {
    setNotifications([]);
    setUnreadCount(0);
    try {
      await api.markAllNotificationsRead();
    } catch {
      await load();
    }
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={handleOpen}
        aria-label="Notifications"
        className="relative flex h-8 w-8 items-center justify-center rounded-lg text-fg-secondary hover:bg-surface-3"
      >
        <Bell size={16} aria-hidden />
        {unreadCount > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-error px-1 text-meta font-semibold text-white">
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-10 z-40 w-80 max-w-[calc(100vw-2rem)] rounded-xl border border-border-subtle bg-surface-2 shadow-2xl">
          <div className="flex items-center justify-between border-b border-border-subtle px-3 py-2.5">
            <span className="text-body font-semibold text-fg">Notifications</span>
            {unreadCount > 0 && (
              <button type="button" onClick={handleMarkAllRead} className="flex items-center gap-1 text-caption font-medium text-accent hover:text-accent-dim">
                <Check size={12} aria-hidden />
                Mark all read
              </button>
            )}
          </div>

          <div className="max-h-96 overflow-y-auto">
            {notifications.length === 0 && <p className="px-3 py-6 text-center text-caption text-fg-muted">No notifications yet.</p>}
            {notifications.map((notification) => (
              <button
                key={notification.id}
                type="button"
                onClick={() => handleMarkRead(notification)}
                className={`flex w-full items-start gap-2.5 border-b border-border-subtle px-3 py-2.5 text-left last:border-b-0 hover:bg-surface-3 ${
                  notification.readAt ? '' : 'bg-accent-soft/40'
                }`}
              >
                <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${SEVERITY_DOT[notification.severity]}`} aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="text-caption font-medium text-fg">{notification.title}</p>
                  {notification.body && <p className="mt-0.5 text-caption text-fg-muted">{notification.body}</p>}
                  <p className="mt-1 text-meta text-fg-muted">{formatRelativeTime(notification.createdAt)}</p>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
