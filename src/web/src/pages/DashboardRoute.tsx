import { useEffect, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  MessageCircle, Users, Phone, Bot, AlertTriangle, ArrowRight, Clock,
  Bell, ShieldCheck, Zap, Activity, TrendingUp, CheckCircle,
} from 'lucide-react';
import {
  api,
  type WorkspaceDashboardOverview,
  type WorkspaceChatSummary,
  type NotificationDto,
  type AiEnginesDto,
  type AiCommitmentRecord,
  type NextBestAction,
  type MorningBriefing,
} from '../lib/api.js';
import { AiEngineStrip } from '../components/AiEngineStrip.js';
import { TimeSyncStrip } from '../components/TimeSyncStrip.js';

// Semantic chart colors — operationally meaningful, separate from accent hue.
const C_AI_ACTIVE    = '#22c55e';
const C_HUMAN        = '#f59e0b';
const C_AI_PAUSED    = '#38bdf8';
const C_ACCENT       = '#6366f1';
const C_ERROR        = '#ef4444';
const C_MUTED        = '#9ca3af';

const CALL_COLOR: Record<string, string> = {
  ended: C_AI_ACTIVE, accepted: C_AI_ACTIVE,
  missed: C_ERROR,    timeout:  C_ERROR,
  rejected: C_HUMAN,  offer: C_AI_PAUSED, ringing: C_AI_PAUSED, unknown: C_MUTED,
};

const CALL_LABEL: Record<string, string> = {
  ended: 'Answered', accepted: 'Answered', missed: 'Missed',
  timeout: 'Timed out', rejected: 'Rejected', offer: 'Ringing',
  ringing: 'Ringing', unknown: 'Unknown',
};

// ── Small reusable helpers ────────────────────────────────────────────────
function relativeTime(iso: string | null): string {
  if (!iso) return '';
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (m < 1)  return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function fmt(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

// ── Tooltip wrapper ───────────────────────────────────────────────────────
function Tip({ children, tip }: { children: ReactNode; tip: string }) {
  return (
    <span className="group relative inline-flex">
      {children}
      <span className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-2 -translate-x-1/2 whitespace-nowrap rounded-lg border border-border-subtle bg-surface-1 px-2.5 py-1.5 text-meta text-fg shadow-lg opacity-0 transition-opacity duration-150 group-hover:opacity-100">
        {tip}
      </span>
    </span>
  );
}

// ── Metric chip (compact, scan-first) ───────────────────────────────────
function Chip({
  icon: Icon,
  label,
  value,
  sub,
  accent,
  urgent,
  onClick,
  tooltip,
}: {
  icon: typeof MessageCircle;
  label: string;
  value: string | number;
  sub?: string;
  accent: string;
  urgent?: boolean;
  onClick?: () => void;
  tooltip?: string;
}) {
  const body = (
    <div
      className={`flex items-center gap-3 rounded-xl border bg-surface-2 px-4 py-3.5 w-full ${
        urgent ? 'border-warning/40 bg-warning/5' : 'border-border-subtle'
      } ${onClick ? 'hover:bg-surface-3 transition-colors' : ''}`}
    >
      <div
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
        style={{ backgroundColor: `${accent}1a` }}
      >
        <Icon size={16} strokeWidth={1.75} style={{ color: accent }} aria-hidden />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-meta text-fg-muted">{label}</p>
        <p className="mt-0.5 text-title font-bold tabular-nums text-fg leading-none">{value}</p>
        {sub && <p className="mt-0.5 text-meta text-fg-muted">{sub}</p>}
      </div>
      {onClick && <ArrowRight size={13} className="shrink-0 text-fg-muted/40" aria-hidden />}
    </div>
  );
  if (onClick) {
    return (
      <button type="button" onClick={onClick} className="w-full text-left" title={tooltip}>
        {body}
      </button>
    );
  }
  return tooltip ? <Tip tip={tooltip}><div className="w-full">{body}</div></Tip> : body;
}

// ── DonutRing (pure SVG) ─────────────────────────────────────────────────
function DonutRing({
  segments, size = 88, stroke = 12, onItemClick,
}: {
  segments: { value: number; color: string; label: string; tooltip?: string }[];
  size?: number; stroke?: number;
  onItemClick?: (seg: { value: number; color: string; label: string }) => void;
}) {
  const r    = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const total = segments.reduce((s, seg) => s + seg.value, 0);
  let off = 0;
  const arcs = segments.map((seg) => {
    const dash = total > 0 ? (seg.value / total) * circ : 0;
    const arc  = { ...seg, dash, gap: circ - dash, dashOffset: -off };
    off += dash;
    return arc;
  });
  return (
    <div className="flex items-center gap-4">
      <div className="relative shrink-0" style={{ width: size, height: size }}>
        <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }} aria-hidden>
          <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="currentColor" strokeWidth={stroke} className="text-surface-3" />
          {arcs.map((arc, i) =>
            arc.value > 0 ? (
              <circle key={i} cx={size/2} cy={size/2} r={r} fill="none"
                stroke={arc.color} strokeWidth={stroke}
                strokeDasharray={`${arc.dash} ${arc.gap}`}
                strokeDashoffset={arc.dashOffset}
              />
            ) : null,
          )}
        </svg>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-body-lg font-bold tabular-nums text-fg leading-none">{total}</span>
          <span className="text-meta text-fg-muted">chats</span>
        </div>
      </div>
      <div className="flex flex-col gap-2">
        {segments.map((seg) => {
          const row = (
            <div
              key={seg.label}
              className={`flex items-center gap-2 rounded-md px-1 py-0.5 ${onItemClick ? 'cursor-pointer hover:bg-surface-3 transition-colors' : ''}`}
              onClick={onItemClick ? () => onItemClick(seg) : undefined}
              role={onItemClick ? 'button' : undefined}
              tabIndex={onItemClick ? 0 : undefined}
              onKeyDown={onItemClick ? (e) => { if (e.key === 'Enter') onItemClick(seg); } : undefined}
            >
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: seg.color }} aria-hidden />
              <span className="text-caption text-fg-secondary">{seg.label}</span>
              <span className="ml-auto pl-3 text-caption font-semibold tabular-nums text-fg">{seg.value}</span>
            </div>
          );
          return seg.tooltip ? <Tip key={seg.label} tip={seg.tooltip}>{row}</Tip> : row;
        })}
      </div>
    </div>
  );
}

// ── Horizontal bar ───────────────────────────────────────────────────────
function HBar({ label, value, max, pct, color, onClick, tooltip }: {
  label: string; value: number; max: number; pct?: number; color: string;
  onClick?: () => void; tooltip?: string;
}) {
  const width = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  const shown = pct !== undefined ? pct : Math.round(width);
  const inner = (
    <div
      className={`flex items-center gap-2.5 rounded-md px-1 py-0.5 ${onClick ? 'cursor-pointer hover:bg-surface-3 transition-colors' : ''}`}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => { if (e.key === 'Enter') onClick(); } : undefined}
    >
      <span className="w-32 shrink-0 truncate text-caption text-fg-secondary">{label}</span>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-3">
        <div className="h-full rounded-full transition-all duration-500" style={{ width: `${width}%`, backgroundColor: color }} />
      </div>
      <span className="w-7 shrink-0 text-right text-caption tabular-nums text-fg-muted">{value}</span>
      <span className="w-8 shrink-0 text-right text-meta text-fg-muted">{shown}%</span>
    </div>
  );
  return tooltip ? <Tip tip={tooltip}><div className="w-full">{inner}</div></Tip> : inner;
}

/**
 * Section 68 (Analytics): the first real trend chart this dashboard has
 * ever had - every other number on this page is a single collapsed
 * period total. No charting library in this project, so a plain
 * CSS-height bar pair per day, same hand-rolled-visualization approach
 * HBar/DonutRing above already use. Fetches on its own (a second real
 * query beyond the main dashboard overview), not preloaded into it.
 */
function MessageVolumeTrend() {
  const [trend, setTrend] = useState<{ date: string; inbound: number; outbound: number }[] | null>(null);

  useEffect(() => {
    api.getMessageVolumeTrend(30).then((res) => setTrend(res.trend)).catch(() => setTrend([]));
  }, []);

  if (trend === null) return <p className="text-caption text-fg-muted">Loading…</p>;
  if (trend.every((day) => day.inbound === 0 && day.outbound === 0)) {
    return <p className="text-caption text-fg-muted">No messages in the last 30 days yet.</p>;
  }

  const max = Math.max(1, ...trend.map((day) => Math.max(day.inbound, day.outbound)));

  return (
    <div>
      <div className="flex h-24 items-end gap-[3px]">
        {trend.map((day) => (
          <Tip key={day.date} tip={`${new Date(day.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} — ${day.inbound} received, ${day.outbound} sent`}>
            <div className="flex flex-1 items-end gap-[1.5px]">
              <div className="flex-1 rounded-t-sm transition-all" style={{ height: `${Math.max(2, (day.inbound / max) * 100)}%`, backgroundColor: C_AI_PAUSED }} />
              <div className="flex-1 rounded-t-sm transition-all" style={{ height: `${Math.max(2, (day.outbound / max) * 100)}%`, backgroundColor: C_ACCENT }} />
            </div>
          </Tip>
        ))}
      </div>
      <div className="mt-2 flex items-center gap-4 text-meta text-fg-muted">
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full" style={{ backgroundColor: C_AI_PAUSED }} aria-hidden />
          Received
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full" style={{ backgroundColor: C_ACCENT }} aria-hidden />
          Sent
        </span>
      </div>
    </div>
  );
}

/**
 * Section 68 (Analytics) follow-up: a live count of where real
 * conversations currently sit in the funnel - the closest thing to a
 * funnel chart buildable on real data today. A snapshot, not a
 * funnel-over-time chart: funnel_stage is overwritten in place, not
 * logged as history (see conversationStateRepository.ts's own doc
 * comment), so this can only ever answer "right now," not "how many
 * entered/exited each stage this week."
 */
const FUNNEL_STAGE_ORDER = [
  'NEW', 'CONVERSING', 'INTENT_IDENTIFIED', 'NEED_IDENTIFIED', 'QUALIFIED',
  'SOLUTION_MATCHED', 'INTEREST_CONFIRMED', 'APPOINTMENT_OFFERED',
  'APPOINTMENT_SELECTED', 'BOOKED', 'FOLLOW_UP', 'CUSTOMER',
];
const FUNNEL_STAGE_LABELS: Record<string, string> = {
  NEW: 'New', CONVERSING: 'Conversing', INTENT_IDENTIFIED: 'Intent identified', NEED_IDENTIFIED: 'Need identified',
  QUALIFIED: 'Qualified', SOLUTION_MATCHED: 'Solution matched', INTEREST_CONFIRMED: 'Interest confirmed',
  APPOINTMENT_OFFERED: 'Appointment offered', APPOINTMENT_SELECTED: 'Appointment selected', BOOKED: 'Booked',
  FOLLOW_UP: 'Follow-up', CUSTOMER: 'Customer',
};

function FunnelStageSnapshot() {
  const [stages, setStages] = useState<Record<string, number> | null>(null);

  useEffect(() => {
    api.getFunnelSnapshot().then((res) => setStages(res.stages)).catch(() => setStages({}));
  }, []);

  if (stages === null) return <p className="text-caption text-fg-muted">Loading…</p>;
  const total = Object.values(stages).reduce((sum, count) => sum + count, 0);
  if (total === 0) return <p className="text-caption text-fg-muted">No conversation has reached a funnel stage yet.</p>;

  const max = Math.max(1, ...Object.values(stages));
  return (
    <div className="space-y-1">
      {FUNNEL_STAGE_ORDER.filter((stage) => (stages[stage] ?? 0) > 0).map((stage) => (
        <HBar key={stage} label={FUNNEL_STAGE_LABELS[stage] ?? stage} value={stages[stage] ?? 0} max={max} color={C_ACCENT} />
      ))}
    </div>
  );
}

// ── AI Mode badge ────────────────────────────────────────────────────────
const AI_MODE_STYLE: Record<WorkspaceChatSummary['aiMode'], { label: string; color: string }> = {
  AI_ACTIVE:      { label: 'AI',    color: C_AI_ACTIVE },
  HUMAN_TAKEOVER: { label: 'Human', color: C_HUMAN },
  AI_PAUSED:      { label: 'Paused',color: C_AI_PAUSED },
};

// ── Main component ───────────────────────────────────────────────────────
export function DashboardRoute() {
  const navigate = useNavigate();
  const [overview,       setOverview]       = useState<WorkspaceDashboardOverview | null>(null);
  const [chats,          setChats]          = useState<WorkspaceChatSummary[] | null>(null);
  const [notifications,  setNotifications]  = useState<NotificationDto[] | null>(null);
  const [engines,        setEngines]        = useState<AiEnginesDto | null>(null);
  const [commitments,    setCommitments]    = useState<AiCommitmentRecord[] | null>(null);
  const [nextActions,    setNextActions]    = useState<NextBestAction[] | null>(null);
  const [briefing,       setBriefing]       = useState<MorningBriefing | null>(null);
  const [error,          setError]          = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      api.getDashboard(),
      api.listChats(),
      api.listNotifications(),
      api.getAiEngines().catch(() => null),
      api.getOpenCommitments().catch(() => ({ commitments: [] as AiCommitmentRecord[] })),
      api.getNextBestActions().catch(() => ({ actions: [] as NextBestAction[] })),
      api.getMorningBriefing().catch(() => null),
    ])
      .then(([d, c, n, e, k, nba, brief]) => {
        setOverview(d); setChats(c.chats);
        setNotifications(n.notifications); setEngines(e);
        setCommitments(k.commitments);
        setNextActions(nba.actions);
        setBriefing(brief);
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load dashboard.'));
  }, []);

  if (error) return <div className="flex-1 p-6"><p className="text-caption text-error">{error}</p></div>;
  if (!overview || !chats || !notifications) return null;

  const openCommitments = commitments ?? [];

  // ── Derived metrics ──────────────────────────────────────────────────
  const totalMsgs    = overview.messages.inbound + overview.messages.outbound;
  const totalReplies = overview.outboundReplies.ai + overview.outboundReplies.human;
  const totalCalls   = Object.values(overview.calls).reduce((s, n) => s + n, 0);

  const aiActive        = chats.filter((c) => c.aiMode === 'AI_ACTIVE').length;
  const humanTakeover   = chats.filter((c) => c.aiMode === 'HUMAN_TAKEOVER').length;
  const aiPaused        = chats.filter((c) => c.aiMode === 'AI_PAUSED').length;

  const chatCoverage   = chats.length > 0 ? Math.round((aiActive / chats.length) * 100) : 0;
  const aiReplyPct     = totalReplies > 0 ? Math.round((overview.outboundReplies.ai / totalReplies) * 100) : 0;

  const needsHuman = chats
    .filter((c) => c.aiMode === 'HUMAN_TAKEOVER')
    .sort((a, b) => (b.lastMessageAt ?? '').localeCompare(a.lastMessageAt ?? ''));

  const recentContacts = [...chats]
    .filter((c) => c.lastMessageAt)
    .sort((a, b) => (b.lastMessageAt ?? '').localeCompare(a.lastMessageAt ?? ''))
    .slice(0, 6);

  const criticalAlerts  = notifications.filter((n) => n.severity === 'critical');
  const warningAlerts   = notifications.filter((n) => n.severity === 'warning');
  const unread          = notifications.filter((n) => !n.readAt);

  const aiDown          = engines !== null && !engines.canGenerate;
  const hasAttention    = aiDown || needsHuman.length > 0 || criticalAlerts.length > 0 || openCommitments.length > 0;
  const unreadImportant = notifications.filter((n) => !n.readAt && (n.severity === 'critical' || n.severity === 'warning'));

  // Donut segments
  const donutSegs = [
    { value: aiActive,      color: C_AI_ACTIVE, label: 'AI autopilot', tooltip: `${aiActive} contact${aiActive !== 1 ? 's' : ''} with AI handling replies — click to view` },
    { value: humanTakeover, color: C_HUMAN,     label: 'Needs human',  tooltip: `${humanTakeover} contact${humanTakeover !== 1 ? 's' : ''} waiting on a human reply` },
    { value: aiPaused,      color: C_AI_PAUSED, label: 'AI paused',    tooltip: `${aiPaused} contact${aiPaused !== 1 ? 's' : ''} with AI temporarily paused` },
  ];

  // Pipeline labels — human-readable, not technical
  const pipeline: { label: string; value: number; color: string; tooltip: string; nav: string }[] = [
    { label: 'Total contacts',     value: overview.chats.total,       color: C_MUTED,    tooltip: `All ${overview.chats.total} contacts managed by this workspace`, nav: '/chats' },
    { label: 'Active this period', value: overview.chats.activeSince, color: C_ACCENT,   tooltip: `${overview.chats.activeSince} contacts messaged in the last ${overview.periodDays} days`, nav: '/chats' },
    { label: 'AI autopilot',       value: aiActive,                   color: C_AI_ACTIVE,tooltip: `${aiActive} contacts where AI handles replies automatically`, nav: '/chats' },
    { label: 'Needs attention',    value: humanTakeover,              color: C_HUMAN,    tooltip: humanTakeover > 0 ? `${humanTakeover} contacts waiting on a human reply — act now` : 'No contacts need human attention', nav: '/chats?filter=needsHuman' },
  ];
  const pipelineMax = overview.chats.total || 1;

  return (
    <div className="flex-1 overflow-y-auto bg-surface-0">
      <div className="mx-auto max-w-screen-xl px-6 py-5">

        {/* ── Header ─────────────────────────────────────────────── */}
        <div className="flex items-baseline justify-between">
          <div>
            <h1 className="text-title font-bold text-fg">Dashboard</h1>
            <p className="mt-0.5 text-caption text-fg-muted">
              Last {overview.periodDays} days · live data
            </p>
          </div>
          {hasAttention ? (
            <span className="flex items-center gap-1.5 rounded-full bg-warning/10 px-3 py-1 text-caption font-semibold text-warning">
              <AlertTriangle size={12} aria-hidden />
              Attention needed
            </span>
          ) : (
            <span className="flex items-center gap-1.5 rounded-full bg-success/10 px-3 py-1 text-caption font-semibold text-success">
              <CheckCircle size={12} aria-hidden />
              All systems healthy
            </span>
          )}
        </div>

        {/* ── Alert banners ───────────────────────────────────────── */}
        {hasAttention && (
          <div className="mt-4 space-y-2">
            {aiDown && (
              <div className="flex items-center gap-3 rounded-xl border border-error/30 bg-error/8 px-4 py-3">
                <AlertTriangle size={16} className="shrink-0 text-error" aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="text-body font-semibold text-fg">AI engine is unreachable</p>
                  <p className="text-caption text-fg-muted">Neither Gemini nor Goose can reply. All conversations fall to human agents.</p>
                </div>
                <button type="button" onClick={() => navigate('/agents')}
                  className="flex shrink-0 items-center gap-1 rounded-lg bg-error px-3 py-1.5 text-caption font-semibold text-white hover:opacity-90">
                  Fix now <ArrowRight size={11} aria-hidden />
                </button>
              </div>
            )}
          </div>
        )}

        {/* ── Morning Briefing: "what happened while you were away" - real counts only ── */}
        {briefing && (
          briefing.completedActions.length + briefing.failedActions.length + briefing.riskFlags.length
            + briefing.newAppointments.length + briefing.newLeads.length
            + briefing.autonomousActivity.ACTION_TAKEN + briefing.autonomousActivity.FINDING > 0
        ) && (
          <div className="mt-4 rounded-xl border border-border-subtle bg-surface-1">
            <div className="flex items-center gap-2 border-b border-border-subtle px-4 py-2.5">
              <CheckCircle size={14} className="text-accent" aria-hidden />
              <p className="text-caption font-semibold text-fg">Since you last checked</p>
            </div>
            <div className="grid grid-cols-2 gap-px bg-border-subtle sm:grid-cols-3 lg:grid-cols-6">
              {briefing.completedActions.length > 0 && (
                <div className="bg-surface-1 px-4 py-3">
                  <p className="text-title font-semibold text-fg">{briefing.completedActions.length}</p>
                  <p className="text-meta text-fg-muted">Completed</p>
                </div>
              )}
              {briefing.failedActions.length > 0 && (
                <button type="button" onClick={() => navigate('/approvals')} className="bg-surface-1 px-4 py-3 text-left hover:bg-surface-2">
                  <p className="text-title font-semibold text-error">{briefing.failedActions.length}</p>
                  <p className="text-meta text-fg-muted">Failed</p>
                </button>
              )}
              {briefing.pendingApprovals.length > 0 && (
                <button type="button" onClick={() => navigate('/approvals')} className="bg-surface-1 px-4 py-3 text-left hover:bg-surface-2">
                  <p className="text-title font-semibold text-warning">{briefing.pendingApprovals.length}</p>
                  <p className="text-meta text-fg-muted">Waiting for you</p>
                </button>
              )}
              {briefing.riskFlags.length > 0 && (
                <div className="bg-surface-1 px-4 py-3">
                  <p className="text-title font-semibold text-warning">{briefing.riskFlags.length}</p>
                  <p className="text-meta text-fg-muted">Flagged conversations</p>
                </div>
              )}
              {briefing.newAppointments.length > 0 && (
                <div className="bg-surface-1 px-4 py-3">
                  <p className="text-title font-semibold text-fg">{briefing.newAppointments.length}</p>
                  <p className="text-meta text-fg-muted">New appointments</p>
                </div>
              )}
              {briefing.newLeads.length > 0 && (
                <button type="button" onClick={() => navigate('/crm')} className="bg-surface-1 px-4 py-3 text-left hover:bg-surface-2">
                  <p className="text-title font-semibold text-fg">{briefing.newLeads.length}</p>
                  <p className="text-meta text-fg-muted">New leads</p>
                </button>
              )}
              {briefing.autonomousActivity.ACTION_TAKEN > 0 && (
                <div className="bg-surface-1 px-4 py-3">
                  <p className="text-title font-semibold text-fg">{briefing.autonomousActivity.ACTION_TAKEN}</p>
                  <p className="text-meta text-fg-muted">Handled while you were away</p>
                </div>
              )}
              {briefing.autonomousActivity.FINDING > 0 && (
                <div className="bg-surface-1 px-4 py-3">
                  <p className="text-title font-semibold text-fg">{briefing.autonomousActivity.FINDING}</p>
                  <p className="text-meta text-fg-muted">Autonomous suggestions</p>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── Next best actions: one real, ranked "what to do" list ── */}
        {nextActions && nextActions.length > 0 && (
          <div className="mt-4 rounded-xl border border-border-subtle bg-surface-1">
            <div className="flex items-center gap-2 border-b border-border-subtle px-4 py-2.5">
              <Zap size={14} className="text-accent" aria-hidden />
              <p className="text-caption font-semibold text-fg">What to do next</p>
            </div>
            <div>
              {nextActions.slice(0, 6).map((action) => (
                <button
                  key={action.id}
                  type="button"
                  onClick={() => navigate(action.link)}
                  className="flex w-full items-start gap-3 border-b border-border-subtle px-4 py-2.5 text-left last:border-0 hover:bg-surface-2"
                >
                  {action.priority === 'action_needed' ? (
                    <Clock size={14} className="mt-0.5 shrink-0 text-warning" aria-hidden />
                  ) : (
                    <Zap size={14} className="mt-0.5 shrink-0 text-accent" aria-hidden />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-caption font-medium text-fg">{action.title}</p>
                    <p className="truncate text-meta text-fg-muted">{action.description}</p>
                  </div>
                  <span className="shrink-0 text-meta text-fg-muted">{relativeTime(action.occurredAt)}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* ── 6 compact metric chips ──────────────────────────────── */}
        <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
          <Chip icon={MessageCircle} label="Messages" accent={C_ACCENT}
            value={fmt(totalMsgs)}
            sub={`${fmt(overview.messages.inbound)} received · ${fmt(overview.messages.outbound)} sent`}
            tooltip={`${totalMsgs} total messages — ${overview.messages.inbound} inbound, ${overview.messages.outbound} outbound`} />
          <Chip icon={Users} label="Active contacts" accent={C_AI_PAUSED}
            value={overview.chats.activeSince}
            sub={`of ${overview.chats.total} total managed`}
            tooltip={`${overview.chats.activeSince} contacts active in the last ${overview.periodDays} days`}
            onClick={() => navigate('/chats')} />
          <Chip icon={Zap} label="AI autopilot" accent={C_AI_ACTIVE}
            value={`${chatCoverage}%`}
            sub={`${aiActive} of ${chats.length} contacts`}
            tooltip={`${aiActive} of ${chats.length} contacts are on AI autopilot`}
            onClick={() => navigate('/chats')} />
          <Chip icon={Bot} label="AI replies" accent={C_ACCENT}
            value={fmt(overview.outboundReplies.ai)}
            sub={totalReplies > 0 ? `${aiReplyPct}% of all outbound` : 'No replies yet'}
            tooltip={`AI sent ${overview.outboundReplies.ai} of ${totalReplies} replies (${aiReplyPct}%)`}
            onClick={() => navigate('/chats')} />
          <Chip icon={Phone} label="Calls" accent={C_MUTED}
            value={totalCalls}
            sub={totalCalls > 0 ? `${(overview.calls['ended'] ?? 0) + (overview.calls['accepted'] ?? 0)} answered` : 'None this period'}
            tooltip={totalCalls > 0 ? `${totalCalls} calls — ${(overview.calls['ended'] ?? 0) + (overview.calls['accepted'] ?? 0)} answered, ${(overview.calls['missed'] ?? 0)} missed` : 'No calls this period'} />
          <Chip icon={Bell} label="Alerts" accent={needsHuman.length > 0 || criticalAlerts.length > 0 ? C_HUMAN : C_AI_ACTIVE}
            urgent={needsHuman.length > 0 || criticalAlerts.length > 0}
            value={criticalAlerts.length > 0 ? `${criticalAlerts.length} critical` : unread.length > 0 ? `${unread.length} unread` : 'Clear'}
            sub={criticalAlerts.length === 0 && warningAlerts.length > 0 ? `${warningAlerts.length} warning${warningAlerts.length !== 1 ? 's' : ''}` : 'No issues'}
            tooltip={unread.length > 0 ? `${unread.length} unread notification${unread.length !== 1 ? 's' : ''} — ${criticalAlerts.length} critical, ${warningAlerts.length} warnings` : 'All notifications read'}
            onClick={unread.length > 0 || criticalAlerts.length > 0 ? () => navigate('/settings') : undefined} />
        </div>

        {/* ── Charts row ─────────────────────────────────────────── */}
        <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-3">

          {/* Conversation modes donut */}
          <div className="rounded-xl border border-border-subtle bg-surface-2 p-4">
            <p className="mb-3 text-caption font-semibold text-fg-muted uppercase tracking-wide">Chat Modes</p>
            <p className="mb-3 text-meta text-fg-muted">How AI is currently configured across all your contacts</p>
            {chats.length === 0
              ? <p className="text-body text-fg-muted">No chats yet.</p>
              : <DonutRing segments={donutSegs} onItemClick={(seg) => navigate(seg.label === 'Needs human' ? '/chats?filter=needsHuman' : '/chats')} />
            }
          </div>

          {/* Reply automation */}
          <div className="rounded-xl border border-border-subtle bg-surface-2 p-4">
            <p className="mb-1 text-caption font-semibold text-fg-muted uppercase tracking-wide">Reply Automation</p>
            <p className="mb-3 text-meta text-fg-muted">Share of outbound messages sent by AI vs a human agent</p>
            {totalReplies === 0 ? (
              <p className="mt-2 text-body text-fg-muted">No outbound replies this period.</p>
            ) : (
              <>
                <div className="mt-4 flex h-2 overflow-hidden rounded-full bg-surface-3">
                  <div className="h-full transition-all duration-500" style={{ width: `${aiReplyPct}%`, backgroundColor: C_ACCENT }} />
                  <div className="h-full" style={{ width: `${100 - aiReplyPct}%`, backgroundColor: `${C_MUTED}66` }} />
                </div>
                <div className="mt-2.5 flex items-center justify-between text-caption">
                  <span className="flex items-center gap-2 text-fg-secondary">
                    <span className="h-2 w-2 rounded-full" style={{ backgroundColor: C_ACCENT }} aria-hidden />
                    AI — {overview.outboundReplies.ai} replies <span className="text-fg-muted">({aiReplyPct}%)</span>
                  </span>
                  <span className="flex items-center gap-2 text-fg-muted">
                    <span className="h-2 w-2 rounded-full bg-fg-muted/40" aria-hidden />
                    Human — {overview.outboundReplies.human}
                  </span>
                </div>
                <div className="mt-4 rounded-lg bg-surface-3 px-3 py-2.5">
                  {aiReplyPct === 100 ? (
                    <p className="text-caption text-fg-secondary">✓ AI is handling every reply. No human intervention needed.</p>
                  ) : (
                    <p className="text-caption text-fg-secondary">
                      {overview.outboundReplies.human} message{overview.outboundReplies.human !== 1 ? 's' : ''} needed a human —{' '}
                      <button type="button" onClick={() => navigate('/chats?filter=needsHuman')} className="font-medium text-accent underline-offset-2 hover:underline">
                        review those chats
                      </button>.
                    </p>
                  )}
                </div>
              </>
            )}
          </div>

          {/* Notification pulse */}
          <div className="rounded-xl border border-border-subtle bg-surface-2 p-4">
            <p className="mb-1 text-caption font-semibold text-fg-muted uppercase tracking-wide">System Pulse</p>
            <p className="mb-3 text-meta text-fg-muted">Notifications by severity across this workspace</p>
            <div className="space-y-1">
              {(
                [
                  { label: 'Critical', count: criticalAlerts.length,   color: C_ERROR,    tip: criticalAlerts.length > 0 ? `${criticalAlerts.length} critical alert${criticalAlerts.length !== 1 ? 's' : ''} — click to view` : 'No critical alerts' },
                  { label: 'Warnings', count: warningAlerts.length,    color: C_HUMAN,    tip: warningAlerts.length > 0 ? `${warningAlerts.length} warning${warningAlerts.length !== 1 ? 's' : ''} — click to view` : 'No warnings' },
                  { label: 'Info',     count: notifications.filter((n) => n.severity === 'info').length, color: C_AI_PAUSED, tip: 'Informational notifications' },
                  { label: 'Unread',   count: unread.length,           color: C_ACCENT,   tip: unread.length > 0 ? `${unread.length} unread notification${unread.length !== 1 ? 's' : ''} — click to view` : 'All caught up' },
                ] as { label: string; count: number; color: string; tip: string }[]
              ).map(({ label, count, color, tip }) => {
                const isActionable = count > 0 && (label === 'Critical' || label === 'Warnings' || label === 'Unread');
                return (
                  <Tip key={label} tip={tip}>
                    <button
                      type="button"
                      className={`flex w-full items-center gap-3 rounded-md px-1.5 py-1.5 text-left transition-colors ${isActionable ? 'hover:bg-surface-3 cursor-pointer' : 'cursor-default'}`}
                      onClick={isActionable ? () => navigate('/settings') : undefined}
                    >
                      <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: color }} aria-hidden />
                      <span className="flex-1 text-caption text-fg-secondary">{label}</span>
                      <span className={`text-caption font-semibold tabular-nums ${count > 0 && (label === 'Critical' || label === 'Warnings') ? 'text-error' : 'text-fg'}`}>
                        {count}
                      </span>
                      {isActionable && <ArrowRight size={11} className="text-fg-muted/50" aria-hidden />}
                    </button>
                  </Tip>
                );
              })}
            </div>
            {unreadImportant.length > 0 && (
              <div className="mt-3 rounded-lg border border-warning/30 bg-warning/8 px-3 py-2">
                <button type="button" onClick={() => navigate('/settings')} className="w-full text-left">
                  <p className="text-caption font-medium text-warning">
                    {unreadImportant.length} unread important alert{unreadImportant.length !== 1 ? 's' : ''} — tap to view notifications.
                  </p>
                </button>
              </div>
            )}
          </div>
        </div>

        {/* ── Message volume trend (Section 68) ───────────────────── */}
        <div className="mt-3 rounded-xl border border-border-subtle bg-surface-2 p-4">
          <p className="mb-1 flex items-center gap-1.5 text-caption font-semibold text-fg-muted uppercase tracking-wide">
            <TrendingUp size={13} aria-hidden />
            Message volume
          </p>
          <p className="mb-3 text-meta text-fg-muted">Real inbound vs outbound message counts, day by day</p>
          <MessageVolumeTrend />
        </div>

        {/* ── Funnel stage snapshot (Section 68 follow-up) ─────────── */}
        <div className="mt-3 rounded-xl border border-border-subtle bg-surface-2 p-4">
          <p className="mb-1 flex items-center gap-1.5 text-caption font-semibold text-fg-muted uppercase tracking-wide">
            <TrendingUp size={13} aria-hidden />
            Funnel stage snapshot
          </p>
          <p className="mb-3 text-meta text-fg-muted">Where real conversations sit right now, by stage</p>
          <FunnelStageSnapshot />
        </div>

        {/* ── Breakdown row ──────────────────────────────────────── */}
        <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">

          {/* Contact overview (was "Chat pipeline") */}
          <div className="rounded-xl border border-border-subtle bg-surface-2 p-4">
            <p className="mb-1 text-caption font-semibold text-fg-muted uppercase tracking-wide">Contact Overview</p>
            <p className="mb-4 text-meta text-fg-muted">
              Where your {overview.chats.total} contacts are in the conversation funnel
            </p>
            <div className="space-y-1">
              {pipeline.map((row) => (
                <HBar key={row.label} label={row.label} value={row.value}
                  max={pipelineMax} color={row.color}
                  pct={pipelineMax > 0 ? Math.round((row.value / pipelineMax) * 100) : 0}
                  onClick={() => navigate(row.nav)}
                  tooltip={row.tooltip} />
              ))}
            </div>
            <p className="mt-3 text-meta text-fg-muted">
              Note: "AI autopilot" reflects the current mode setting, not whether a conversation was active this period.
            </p>
          </div>

          {/* Call summary (was "Calls by outcome") */}
          <div className="rounded-xl border border-border-subtle bg-surface-2 p-4">
            <p className="mb-1 text-caption font-semibold text-fg-muted uppercase tracking-wide">Call Summary</p>
            <p className="mb-4 text-meta text-fg-muted">
              {totalCalls === 0
                ? 'No calls were logged this period.'
                : `${totalCalls} call${totalCalls !== 1 ? 's' : ''} logged — breakdown by result`}
            </p>
            {totalCalls === 0 ? (
              <div className="flex flex-col items-center justify-center py-6 text-fg-muted">
                <Phone size={28} strokeWidth={1.25} className="mb-2 opacity-40" aria-hidden />
                <p className="text-caption">No call activity in the last {overview.periodDays} days</p>
              </div>
            ) : (
              <div className="space-y-1">
                {Object.entries(overview.calls).map(([status, count]) => (
                  <HBar
                    key={status}
                    label={CALL_LABEL[status] ?? status}
                    value={count}
                    max={totalCalls}
                    color={CALL_COLOR[status] ?? C_MUTED}
                    pct={Math.round((count / totalCalls) * 100)}
                    tooltip={`${count} call${count !== 1 ? 's' : ''} ${(CALL_LABEL[status] ?? status).toLowerCase()} — ${Math.round((count / totalCalls) * 100)}% of total`}
                  />
                ))}
              </div>
            )}
          </div>
        </div>

        {/* ── Contacts + Activity row ─────────────────────────────── */}
        <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-2">

          {/* Recent contacts — most active, with mode badge */}
          <div className="rounded-xl border border-border-subtle bg-surface-2">
            <div className="border-b border-border-subtle px-4 py-3">
              <p className="text-caption font-semibold text-fg-muted uppercase tracking-wide">Recent Contacts</p>
              <p className="mt-0.5 text-meta text-fg-muted">Most recently active conversations</p>
            </div>
            {recentContacts.length === 0 ? (
              <div className="px-4 py-6 text-center text-caption text-fg-muted">No conversations yet.</div>
            ) : (
              <div className="divide-y divide-border-subtle">
                {recentContacts.map((chat) => {
                  const mode = AI_MODE_STYLE[chat.aiMode];
                  return (
                    <button
                      key={chat.id}
                      type="button"
                      onClick={() => navigate(`/chats/${chat.id}`)}
                      className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-surface-3 transition-colors"
                    >
                      {/* Initials avatar */}
                      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent/10 text-caption font-semibold text-accent">
                        {(chat.displayName?.[0] ?? '?').toUpperCase()}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <p className="truncate text-caption font-semibold text-fg">{chat.displayName}</p>
                          <span
                            className="shrink-0 rounded-full px-1.5 py-0.5 text-meta font-semibold"
                            style={{ backgroundColor: `${mode.color}18`, color: mode.color }}
                          >
                            {mode.label}
                          </span>
                        </div>
                        {chat.lastMessagePreview && (
                          <p className="mt-0.5 truncate text-meta text-fg-muted">{chat.lastMessagePreview}</p>
                        )}
                      </div>
                      {chat.lastMessageAt && (
                        <span className="shrink-0 text-meta text-fg-muted">{relativeTime(chat.lastMessageAt)}</span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
            {needsHuman.length > 0 && (
              <div className="border-t border-border-subtle px-4 py-2.5">
                <button type="button" onClick={() => navigate('/chats?filter=needsHuman')} className="w-full text-left">
                  <p className="text-caption font-semibold text-warning hover:underline underline-offset-2">
                    ⚠ {needsHuman.length} contact{needsHuman.length !== 1 ? 's' : ''} waiting on a human reply →
                  </p>
                </button>
              </div>
            )}
          </div>

          {/* Activity feed */}
          <div className="rounded-xl border border-border-subtle bg-surface-2">
            <div className="border-b border-border-subtle px-4 py-3">
              <p className="text-caption font-semibold text-fg-muted uppercase tracking-wide">Activity Feed</p>
              <p className="mt-0.5 text-meta text-fg-muted">System events and AI actions, newest first</p>
            </div>
            {notifications.length === 0 ? (
              <div className="px-4 py-6 text-center text-caption text-fg-muted">Nothing logged yet.</div>
            ) : (
              <div className="divide-y divide-border-subtle">
                {notifications.slice(0, 7).map((n) => (
                  <div key={n.id} className="flex items-start gap-2.5 px-4 py-2.5">
                    <span
                      className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${
                        n.severity === 'critical' ? 'bg-error' :
                        n.severity === 'warning'  ? 'bg-warning' : 'bg-accent'
                      }`}
                      aria-hidden
                    />
                    <div className="min-w-0 flex-1">
                      <p className="text-caption font-medium text-fg">{n.title}</p>
                      {n.body && <p className="mt-0.5 truncate text-meta text-fg-muted">{n.body}</p>}
                    </div>
                    <span className="shrink-0 text-meta text-fg-muted">{relativeTime(n.createdAt)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* ── System health (compact strip) ───────────────────────── */}
        <div className="mt-3 rounded-xl border border-border-subtle bg-surface-2 p-4">
          <div className="mb-3 flex items-center gap-2">
            <Activity size={13} className="text-fg-muted" aria-hidden />
            <p className="text-caption font-semibold text-fg-muted uppercase tracking-wide">System Health</p>
          </div>
          <div className="flex flex-col gap-2">
            <AiEngineStrip />
            <TimeSyncStrip />
          </div>
        </div>

        <p className="mt-4 text-meta text-fg-muted">
          Data refreshes on page load. Computed from synced WhatsApp activity — not estimates.
        </p>

      </div>
    </div>
  );
}
