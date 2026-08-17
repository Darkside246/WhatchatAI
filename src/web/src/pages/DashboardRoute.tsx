import { useEffect, useState } from 'react';
import { MessageCircle, Users, Phone, Bot } from 'lucide-react';
import { api, type WorkspaceDashboardOverview } from '../lib/api.js';

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

export function DashboardRoute() {
  const [dashboard, setDashboard] = useState<WorkspaceDashboardOverview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .getDashboard()
      .then(setDashboard)
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load dashboard.'));
  }, []);

  if (error) {
    return (
      <div className="flex-1 p-6">
        <p className="text-caption text-error">{error}</p>
      </div>
    );
  }

  if (!dashboard) return null;

  const totalCalls = Object.values(dashboard.calls).reduce((sum, count) => sum + count, 0);
  const totalMessages = dashboard.messages.inbound + dashboard.messages.outbound;

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <h1 className="text-title font-semibold text-fg">Dashboard</h1>
      <p className="mt-1 text-body text-fg-muted">
        Real activity from the last {dashboard.periodDays} days - computed from your actual synced data, not estimated.
      </p>

      <div className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
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
        <StatCard icon={Bot} label="AI replies sent" value={dashboard.outboundReplies.ai} />
      </div>

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
    </div>
  );
}
