import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { MessageCircle, Users, Phone, Bot, AlertTriangle, ArrowRight, Clock, Bell, ShieldCheck } from 'lucide-react';
import {
  api,
  type WorkspaceDashboardOverview,
  type WorkspaceChatSummary,
  type NotificationDto,
  type AiEnginesDto,
} from '../lib/api.js';
import { AiEngineStrip } from '../components/AiEngineStrip.js';

function StatCard({
  icon: Icon,
  label,
  value,
  sublabel,
}: {
  icon: typeof MessageCircle;
  label: string;
  value: string | number;
  sublabel?: string;
}) {
  return (
    <div className="rounded-xl border border-border-subtle bg-surface-2 p-4">
      <div className="flex items-center gap-2 text-fg-muted">
        <Icon size={16} strokeWidth={1.75} aria-hidden />
        <span className="text-caption">{label}</span>
      </div>
      <p className="mt-2 text-display font-semibold text-fg">{value}</p>
      {sublabel && <p className="mt-0.5 text-caption text-fg-muted">{sublabel}</p>}
    </div>
  );
}

function SplitBar({ label, a, aLabel, b, bLabel }: { label: string; a: number; aLabel: string; b: number; bLabel: string }) {
  const total = a + b;
  const aPercent = total > 0 ? Math.round((a / total) * 100) : 0;
  return (
    <div className="rounded-xl border border-border-subtle bg-surface-2 p-4">
      <p className="text-caption text-fg-muted">{label}</p>
      {total === 0 ? (
        <p className="mt-2 text-body text-fg-muted">No real replies sent yet in this period.</p>
      ) : (
        <>
          <div className="mt-3 flex h-2 overflow-hidden rounded-full bg-surface-3">
            <div className="h-full bg-accent" style={{ width: `${aPercent}%` }} />
            <div className="h-full bg-fg-muted/40" style={{ width: `${100 - aPercent}%` }} />
          </div>
          <div className="mt-2 flex items-center justify-between text-caption">
            <span className="text-fg-secondary">
              {aLabel}: {a}
            </span>
            <span className="text-fg-muted">
              {bLabel}: {b}
            </span>
          </div>
        </>
      )}
    </div>
  );
}

const CALL_STATUS_LABEL: Record<string, string> = {
  ended: 'Answered',
  accepted: 'Answered',
  missed: 'Missed',
  timeout: 'Missed (timeout)',
  rejected: 'Rejected',
  offer: 'Ringing',
  ringing: 'Ringing',
  unknown: 'Unknown',
};

function relativeTime(iso: string | null): string {
  if (!iso) return '';
  const diffMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(diffMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

const SEVERITY_DOT: Record<NotificationDto['severity'], string> = {
  critical: 'bg-error',
  warning: 'bg-warning',
  info: 'bg-accent',
};

/**
 * Everything here is real and computed from the same tables the rest of the
 * workspace reads - a chat only appears in "needs a reply" because its
 * ai_mode is genuinely HUMAN_TAKEOVER right now (set by the routing/reply
 * pipeline itself, per the fixes that make no_agent/blocked/failed outcomes
 * visible instead of silent), and the activity feed is the real notification
 * log, not a fabricated event stream.
 */
export function DashboardRoute() {
  const navigate = useNavigate();
  const [dashboard, setDashboard] = useState<WorkspaceDashboardOverview | null>(null);
  const [chats, setChats] = useState<WorkspaceChatSummary[] | null>(null);
  const [notifications, setNotifications] = useState<NotificationDto[] | null>(null);
  const [engines, setEngines] = useState<AiEnginesDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      api.getDashboard(),
      api.listChats(),
      api.listNotifications(),
      api.getAiEngines().catch(() => null),
    ])
      .then(([dashboardRes, chatsRes, notificationsRes, enginesRes]) => {
        setDashboard(dashboardRes);
        setChats(chatsRes.chats);
        setNotifications(notificationsRes.notifications);
        setEngines(enginesRes);
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load dashboard.'));
  }, []);

  if (error) {
    return (
      <div className="flex-1 p-6">
        <p className="text-caption text-error">{error}</p>
      </div>
    );
  }

  if (!dashboard || !chats || !notifications) return null;

  const totalCalls = Object.values(dashboard.calls).reduce((sum, count) => sum + count, 0);
  const totalMessages = dashboard.messages.inbound + dashboard.messages.outbound;
  const totalReplies = dashboard.outboundReplies.ai + dashboard.outboundReplies.human;
  const aiSharePercent = totalReplies > 0 ? Math.round((dashboard.outboundReplies.ai / totalReplies) * 100) : null;

  const needsHuman = chats
    .filter((chat) => chat.aiMode === 'HUMAN_TAKEOVER')
    .sort((a, b) => (b.lastMessageAt ?? '').localeCompare(a.lastMessageAt ?? ''));

  const aiDown = engines !== null && !engines.canGenerate;
  const unreadImportant = notifications.filter((n) => !n.readAt && (n.severity === 'critical' || n.severity === 'warning'));
  const hasAttention = aiDown || needsHuman.length > 0 || unreadImportant.length > 0;

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <h1 className="text-title font-semibold text-fg">Dashboard</h1>
      <p className="mt-1 text-body text-fg-muted">
        Real activity from the last {dashboard.periodDays} days - computed from your actual synced data, not estimated.
      </p>

      {/* ATTENTION - the one thing to check before anything else, or an honest all-clear. */}
      <section className="mt-5">
        {hasAttention ? (
          <div className="space-y-2">
            {aiDown && (
              <div className="flex items-center gap-3 rounded-xl border border-error/40 bg-error/10 px-4 py-3">
                <AlertTriangle size={18} className="shrink-0 text-error" aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="text-body font-medium text-fg">No AI engine can reply right now</p>
                  <p className="text-caption text-fg-muted">
                    Neither Gemini nor Goose is available - every conversation is relying on a human.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => navigate('/agents')}
                  className="flex shrink-0 items-center gap-1 rounded-lg bg-error px-3 py-1.5 text-caption font-medium text-white hover:opacity-90"
                >
                  Fix now <ArrowRight size={12} aria-hidden />
                </button>
              </div>
            )}
            {needsHuman.length > 0 && (
              <div className="flex items-center gap-3 rounded-xl border border-warning/40 bg-warning/10 px-4 py-3">
                <Users size={18} className="shrink-0 text-warning" aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="text-body font-medium text-fg">
                    {needsHuman.length} conversation{needsHuman.length === 1 ? '' : 's'} waiting on a human
                  </p>
                  <p className="text-caption text-fg-muted">The AI could not handle these - see the list below.</p>
                </div>
              </div>
            )}
            {unreadImportant.length > 0 && (
              <div className="flex items-center gap-3 rounded-xl border border-border-subtle bg-surface-2 px-4 py-3">
                <Bell size={18} className="shrink-0 text-fg-muted" aria-hidden />
                <p className="text-body text-fg">
                  {unreadImportant.length} unread notification{unreadImportant.length === 1 ? '' : 's'} need a look.
                </p>
              </div>
            )}
          </div>
        ) : (
          <div className="flex items-center gap-2.5 rounded-xl border border-success/30 bg-success/10 px-4 py-3">
            <ShieldCheck size={18} className="shrink-0 text-success" aria-hidden />
            <p className="text-body text-fg">Nothing needs your attention. AI is answering, no chat is stuck.</p>
          </div>
        )}
      </section>

      {/* KPIs */}
      <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          icon={MessageCircle}
          label="Messages"
          value={totalMessages}
          sublabel={`${dashboard.messages.inbound} in · ${dashboard.messages.outbound} out`}
        />
        <StatCard
          icon={Users}
          label="Active chats"
          value={dashboard.chats.activeSince}
          sublabel={`${dashboard.chats.total} total`}
        />
        <StatCard icon={Phone} label="Calls" value={totalCalls} />
        <StatCard
          icon={Bot}
          label="AI replies sent"
          value={dashboard.outboundReplies.ai}
          sublabel={aiSharePercent !== null ? `${aiSharePercent}% of all replies` : undefined}
        />
      </div>

      {/* CONVERSATION / AI PERFORMANCE */}
      <div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-2">
        <SplitBar
          label="Who's replying"
          a={dashboard.outboundReplies.ai}
          aLabel="AI"
          b={dashboard.outboundReplies.human}
          bLabel="Human"
        />

        <div className="rounded-xl border border-border-subtle bg-surface-2 p-4">
          <p className="text-caption text-fg-muted">Calls by outcome</p>
          {totalCalls === 0 ? (
            <p className="mt-2 text-body text-fg-muted">No real calls in this period.</p>
          ) : (
            <div className="mt-3 space-y-1.5">
              {Object.entries(dashboard.calls).map(([status, count]) => (
                <div key={status} className="flex items-center justify-between text-caption">
                  <span className="text-fg-secondary">{CALL_STATUS_LABEL[status] ?? status}</span>
                  <span className="text-fg-muted">{count}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* NEEDS ATTENTION - the actual, actionable list, not just a count. */}
      {needsHuman.length > 0 && (
        <section className="mt-6">
          <h2 className="text-body font-semibold text-fg">Needs a human reply</h2>
          <div className="mt-2 divide-y divide-border-subtle rounded-xl border border-border-subtle bg-surface-2">
            {needsHuman.slice(0, 6).map((chat) => (
              <button
                key={chat.id}
                type="button"
                onClick={() => navigate(`/chats/${chat.id}`)}
                className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-surface-3"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-body font-medium text-fg">{chat.displayName}</p>
                  {chat.lastMessagePreview && (
                    <p className="mt-0.5 truncate text-caption text-fg-muted">{chat.lastMessagePreview}</p>
                  )}
                </div>
                {chat.lastMessageAt && (
                  <span className="flex shrink-0 items-center gap-1 text-meta text-fg-muted">
                    <Clock size={11} aria-hidden />
                    {relativeTime(chat.lastMessageAt)}
                  </span>
                )}
                <ArrowRight size={14} className="shrink-0 text-fg-muted" aria-hidden />
              </button>
            ))}
          </div>
          {needsHuman.length > 6 && (
            <p className="mt-1.5 text-caption text-fg-muted">+{needsHuman.length - 6} more in your inbox.</p>
          )}
        </section>
      )}

      {/* ACTIVITY - the real notification log, most recent first. */}
      <section className="mt-6">
        <h2 className="text-body font-semibold text-fg">Recent activity</h2>
        {notifications.length === 0 ? (
          <p className="mt-2 text-caption text-fg-muted">Nothing has happened yet.</p>
        ) : (
          <div className="mt-2 divide-y divide-border-subtle rounded-xl border border-border-subtle bg-surface-2">
            {notifications.slice(0, 8).map((notification) => (
              <div key={notification.id} className="flex items-start gap-2.5 px-4 py-2.5">
                <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${SEVERITY_DOT[notification.severity]}`} aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="text-caption font-medium text-fg">{notification.title}</p>
                  {notification.body && <p className="mt-0.5 truncate text-meta text-fg-muted">{notification.body}</p>}
                </div>
                <span className="shrink-0 text-meta text-fg-muted">{relativeTime(notification.createdAt)}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* SYSTEM HEALTH - the same real, non-vacuous engine status shown elsewhere in the product. */}
      <section className="mt-6">
        <h2 className="text-body font-semibold text-fg">System health</h2>
        <div className="mt-2">
          <AiEngineStrip />
        </div>
      </section>
    </div>
  );
}
