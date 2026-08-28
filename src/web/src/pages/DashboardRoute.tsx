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
import { TimeSyncStrip } from '../components/TimeSyncStrip.js';

// Semantic chart colors — separate from the design-system accent so each
// carries standalone operational meaning independent of theme choice.
const C_AI_ACTIVE = '#22c55e';
const C_HUMAN_TAKEOVER = '#f59e0b';
const C_AI_PAUSED = '#38bdf8';
const C_ACCENT = '#6366f1';
const C_ERROR = '#ef4444';
const C_MUTED = '#9ca3af';

const CALL_COLOR: Record<string, string> = {
  ended: C_AI_ACTIVE,
  accepted: C_AI_ACTIVE,
  missed: C_ERROR,
  timeout: C_ERROR,
  rejected: C_HUMAN_TAKEOVER,
  offer: C_AI_PAUSED,
  ringing: C_AI_PAUSED,
  unknown: C_MUTED,
};

function DonutRing({
  segments,
  size = 96,
  stroke = 14,
}: {
  segments: { value: number; color: string; label: string }[];
  size?: number;
  stroke?: number;
}) {
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const total = segments.reduce((s, seg) => s + seg.value, 0);
  const cx = size / 2;
  const cy = size / 2;
  let off = 0;
  const arcs = segments.map((seg) => {
    const dash = total > 0 ? (seg.value / total) * circ : 0;
    const arc = { ...seg, dash, gap: circ - dash, dashOffset: -off };
    off += dash;
    return arc;
  });

  return (
    <div className="flex items-center gap-5">
      <div className="relative shrink-0" style={{ width: size, height: size }}>
        <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }} aria-hidden>
          <circle cx={cx} cy={cy} r={r} fill="none" stroke="currentColor" strokeWidth={stroke} className="text-surface-3" />
          {arcs.map((arc, i) =>
            arc.value > 0 ? (
              <circle
                key={i}
                cx={cx}
                cy={cy}
                r={r}
                fill="none"
                stroke={arc.color}
                strokeWidth={stroke}
                strokeDasharray={`${arc.dash} ${arc.gap}`}
                strokeDashoffset={arc.dashOffset}
              />
            ) : null,
          )}
        </svg>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-title font-bold tabular-nums text-fg">{total}</span>
          <span className="text-meta text-fg-muted">chats</span>
        </div>
      </div>
      <div className="flex flex-col gap-2">
        {segments.map((seg) => (
          <div key={seg.label} className="flex items-center gap-2">
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: seg.color }} aria-hidden />
            <span className="text-caption text-fg-secondary">{seg.label}</span>
            <span className="ml-2 text-caption font-semibold tabular-nums text-fg">{seg.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function HorizBar({ label, value, max, color }: { label: string; value: number; max: number; color: string }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div className="flex items-center gap-2.5">
      <span className="w-32 shrink-0 truncate text-caption text-fg-secondary">{label}</span>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-3">
        <div className="h-full rounded-full transition-all duration-500" style={{ width: `${pct}%`, backgroundColor: color }} />
      </div>
      <span className="w-5 shrink-0 text-right text-caption tabular-nums text-fg-muted">{value}</span>
    </div>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
  sublabel,
  accent,
}: {
  icon: typeof MessageCircle;
  label: string;
  value: string | number;
  sublabel?: string;
  accent: string;
}) {
  return (
    <div className="relative overflow-hidden rounded-xl border border-border-subtle bg-surface-2 p-4">
      <div className="absolute inset-y-0 left-0 w-1 rounded-l-xl" style={{ backgroundColor: accent }} aria-hidden />
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
            <div className="h-full transition-all duration-500" style={{ width: `${aPercent}%`, backgroundColor: C_ACCENT }} />
            <div className="h-full" style={{ width: `${100 - aPercent}%`, backgroundColor: `${C_MUTED}66` }} />
          </div>
          <div className="mt-2 flex items-center justify-between text-caption">
            <span className="flex items-center gap-1.5 text-fg-secondary">
              <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: C_ACCENT }} aria-hidden />
              {aLabel}: {a}
              {' '}<span className="text-fg-muted">({aPercent}%)</span>
            </span>
            <span className="flex items-center gap-1.5 text-fg-muted">
              <span className="h-1.5 w-1.5 rounded-full bg-fg-muted/40" aria-hidden />
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
 * workspace reads — chats only appear in "needs a reply" because their
 * ai_mode is genuinely HUMAN_TAKEOVER right now, and the activity feed is
 * the real notification log, not a fabricated event stream.
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

  const aiActiveCount = chats.filter((c) => c.aiMode === 'AI_ACTIVE').length;
  const humanTakeoverCount = chats.filter((c) => c.aiMode === 'HUMAN_TAKEOVER').length;
  const aiPausedCount = chats.filter((c) => c.aiMode === 'AI_PAUSED').length;

  const needsHuman = chats
    .filter((chat) => chat.aiMode === 'HUMAN_TAKEOVER')
    .sort((a, b) => (b.lastMessageAt ?? '').localeCompare(a.lastMessageAt ?? ''));

  const aiDown = engines !== null && !engines.canGenerate;
  const unreadImportant = notifications.filter((n) => !n.readAt && (n.severity === 'critical' || n.severity === 'warning'));
  const hasAttention = aiDown || needsHuman.length > 0 || unreadImportant.length > 0;

  const chatDonutSegments = [
    { value: aiActiveCount, color: C_AI_ACTIVE, label: 'AI Active' },
    { value: humanTakeoverCount, color: C_HUMAN_TAKEOVER, label: 'Needs human' },
    { value: aiPausedCount, color: C_AI_PAUSED, label: 'AI Paused' },
  ];

  const stagePipeline = [
    { label: 'All conversations', value: dashboard.chats.total, color: C_MUTED },
    { label: `Active (${dashboard.periodDays}d)`, value: dashboard.chats.activeSince, color: C_ACCENT },
    { label: 'AI handling', value: aiActiveCount, color: C_AI_ACTIVE },
    { label: 'Waiting on human', value: humanTakeoverCount, color: C_HUMAN_TAKEOVER },
  ];
  const pipelineMax = dashboard.chats.total || 1;

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <h1 className="text-title font-semibold text-fg">Dashboard</h1>
      <p className="mt-1 text-body text-fg-muted">
        Real activity from the last {dashboard.periodDays} days — computed from your actual synced data, not estimated.
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
                    Neither Gemini nor Goose is available — every conversation is relying on a human.
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
                  <p className="text-caption text-fg-muted">The AI could not handle these — see the list below.</p>
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
          accent={C_ACCENT}
        />
        <StatCard
          icon={Users}
          label="Active chats"
          value={dashboard.chats.activeSince}
          sublabel={`${dashboard.chats.total} total`}
          accent={C_AI_PAUSED}
        />
        <StatCard icon={Phone} label="Calls" value={totalCalls} accent={C_MUTED} />
        <StatCard
          icon={Bot}
          label="AI replies sent"
          value={dashboard.outboundReplies.ai}
          sublabel={aiSharePercent !== null ? `${aiSharePercent}% of all replies` : undefined}
          accent={C_AI_ACTIVE}
        />
      </div>

      {/* CHARTS ROW */}
      <div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-2">
        <div className="rounded-xl border border-border-subtle bg-surface-2 p-4">
          <p className="mb-4 text-caption text-fg-muted">Conversation health</p>
          {chats.length === 0 ? (
            <p className="text-body text-fg-muted">No chats yet.</p>
          ) : (
            <DonutRing segments={chatDonutSegments} />
          )}
        </div>

        <SplitBar
          label="Who's replying"
          a={dashboard.outboundReplies.ai}
          aLabel="AI"
          b={dashboard.outboundReplies.human}
          bLabel="Human"
        />
      </div>

      {/* PIPELINE + CALLS ROW */}
      <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-2">
        <div className="rounded-xl border border-border-subtle bg-surface-2 p-4">
          <p className="mb-4 text-caption text-fg-muted">Chat pipeline</p>
          <div className="space-y-2.5">
            {stagePipeline.map((stage) => (
              <HorizBar key={stage.label} label={stage.label} value={stage.value} max={pipelineMax} color={stage.color} />
            ))}
          </div>
        </div>

        <div className="rounded-xl border border-border-subtle bg-surface-2 p-4">
          <p className="mb-4 text-caption text-fg-muted">Calls by outcome</p>
          {totalCalls === 0 ? (
            <p className="text-body text-fg-muted">No calls in this period.</p>
          ) : (
            <div className="space-y-2.5">
              {Object.entries(dashboard.calls).map(([status, count]) => (
                <HorizBar
                  key={status}
                  label={CALL_STATUS_LABEL[status] ?? status}
                  value={count}
                  max={totalCalls}
                  color={CALL_COLOR[status] ?? C_MUTED}
                />
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
        <div className="mt-2 flex flex-col gap-2">
          <AiEngineStrip />
          <TimeSyncStrip />
        </div>
      </section>
    </div>
  );
}
