import { useEffect, useState } from 'react';
import { PlugZap, CheckCircle2, XCircle, AlertTriangle, Ban } from 'lucide-react';
import { api, ApiError, type IntegrationHealth, type IntegrationHealthEntry, type IntegrationHealthState } from '../lib/api.js';

/**
 * Section 120 (Integration Health Centre): the single, real, honest status
 * of every integration this product has, in one place. Every value comes
 * straight from workspaceService.getIntegrationHealth - this page never
 * computes or guesses a status of its own.
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

export function IntegrationHealthPage() {
  const [health, setHealth] = useState<IntegrationHealth | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        setHealth(await api.getIntegrationHealth());
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Failed to load integration status.');
      }
    })();
  }, []);

  const categories: IntegrationHealthEntry['category'][] = ['messaging', 'meetings', 'email', 'payments', 'ai'];
  const grouped = health
    ? categories
        .map((category) => ({ category, entries: health.integrations.filter((i) => i.category === category) }))
        .filter((g) => g.entries.length > 0)
    : [];

  return (
    <div className="min-h-0 flex-1 overflow-auto bg-surface-0 p-5 sm:p-8">
      <div className="mx-auto max-w-4xl space-y-6">
        <section className="flex items-start gap-4 rounded-2xl border border-border-subtle bg-surface-1 p-6 sm:p-8">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent">
            <PlugZap size={22} />
          </div>
          <div>
            <p className="text-meta font-semibold tracking-widest text-accent">INTEGRATIONS</p>
            <h1 className="mt-1 text-3xl font-semibold tracking-tight">Every connection, one honest view</h1>
            <p className="mt-3 max-w-2xl text-body leading-7 text-fg-secondary">
              Real status for everything AURA connects to - never shown as connected unless it genuinely is.
            </p>
          </div>
        </section>

        {error && <p className="rounded-xl border border-error/30 bg-error/5 p-4 text-caption text-error">{error}</p>}
        {health === null && !error && <p className="text-caption text-fg-muted">Loading…</p>}

        {grouped.map(({ category, entries }) => (
          <div key={category}>
            <h2 className="mb-2 text-title font-semibold text-fg">{CATEGORY_LABEL[category]}</h2>
            <div className="space-y-2">
              {entries.map((entry) => (
                <div key={entry.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border-subtle bg-surface-1 p-4">
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
    </div>
  );
}
