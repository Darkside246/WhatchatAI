import { useEffect, useState } from 'react';
import { PlugZap } from 'lucide-react';
import { api, ApiError, type IntegrationHealth } from '../lib/api.js';
import { IntegrationHealthList } from '../components/IntegrationHealthList.js';

/**
 * Section 120 (Integration Health Centre): the single, real, honest status
 * of every integration this product has, in one place. Every value comes
 * straight from workspaceService.getIntegrationHealth - this page never
 * computes or guesses a status of its own.
 */

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
        {health && <IntegrationHealthList health={health} />}
      </div>
    </div>
  );
}
