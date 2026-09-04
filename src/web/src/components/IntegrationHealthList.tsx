import { CheckCircle2, XCircle, AlertTriangle, Ban } from 'lucide-react';
import type { IntegrationHealth, IntegrationHealthEntry, IntegrationHealthState } from '../lib/api.js';

/**
 * Shared rendering for a grouped IntegrationHealth response - used by both
 * the tenant-facing IntegrationHealthPage and the developer-only global
 * status section on DeveloperControlPlanePage, so the two views can never
 * silently drift into different status colors/labels for the same states.
 */

const STATE_LABEL: Record<IntegrationHealthState, string> = {
  connected: 'Connected',
  not_connected: 'Not connected',
  not_configured: 'Not configured',
  degraded: 'Degraded',
  unavailable: 'Unavailable',
};

const STATE_COLOR: Record<IntegrationHealthState, string> = {
  connected: 'bg-success/15 text-success',
  not_connected: 'bg-surface-3 text-fg-muted',
  not_configured: 'bg-surface-3 text-fg-muted',
  degraded: 'bg-warning/15 text-warning',
  unavailable: 'bg-error/15 text-error',
};

function StateIcon({ state }: { state: IntegrationHealthState }) {
  if (state === 'connected') return <CheckCircle2 size={16} className="text-success" aria-hidden />;
  if (state === 'degraded') return <AlertTriangle size={16} className="text-warning" aria-hidden />;
  if (state === 'unavailable') return <XCircle size={16} className="text-error" aria-hidden />;
  return <Ban size={16} className="text-fg-muted" aria-hidden />;
}

const CATEGORY_LABEL: Record<IntegrationHealthEntry['category'], string> = {
  meetings: 'Meetings',
  email: 'Email',
  messaging: 'Messaging',
  payments: 'Payments',
  ai: 'AI providers',
};

const CATEGORY_ORDER: IntegrationHealthEntry['category'][] = ['messaging', 'meetings', 'email', 'payments', 'ai'];

export function IntegrationHealthList({ health, compact = false }: { health: IntegrationHealth; compact?: boolean }) {
  const grouped = CATEGORY_ORDER
    .map((category) => ({ category, entries: health.integrations.filter((i) => i.category === category) }))
    .filter((g) => g.entries.length > 0);

  return (
    <div className="space-y-5">
      {grouped.map(({ category, entries }) => (
        <div key={category}>
          <h3 className={compact ? 'mb-1.5 text-caption font-semibold text-fg-secondary' : 'mb-2 text-title font-semibold text-fg'}>
            {CATEGORY_LABEL[category]}
          </h3>
          <div className="space-y-2">
            {entries.map((entry) => (
              <div key={entry.id} className={`flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border-subtle bg-surface-1 ${compact ? 'p-3' : 'p-4'}`}>
                <div className="flex min-w-0 items-center gap-3">
                  <StateIcon state={entry.state} />
                  <div className="min-w-0">
                    <p className="font-medium text-fg">{entry.label}</p>
                    {entry.detail && <p className="mt-0.5 truncate text-caption text-fg-muted">{entry.detail}</p>}
                  </div>
                </div>
                <span className={`shrink-0 rounded-full px-2 py-0.5 text-meta font-medium ${STATE_COLOR[entry.state]}`}>{STATE_LABEL[entry.state]}</span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
