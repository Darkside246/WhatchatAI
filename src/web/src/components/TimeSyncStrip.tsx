import { useEffect, useState } from 'react';
import { Clock, AlertTriangle } from 'lucide-react';
import { api, type TimeStatusResponse } from '../lib/api.js';

const STATUS_TEXT: Record<TimeStatusResponse['timeContext']['syncStatus'], string> = {
  SYNCED: 'internet synchronized',
  DEGRADED: 'degraded',
  STALE: 'stale',
  MANUAL_OVERRIDE: 'manual override',
};

function stateClass(status: TimeStatusResponse['timeContext']['syncStatus']): string {
  if (status === 'SYNCED') return 'bg-success';
  if (status === 'DEGRADED') return 'bg-warning';
  if (status === 'MANUAL_OVERRIDE') return 'bg-info';
  return 'bg-error';
}

const POLL_MS = 30_000;

/** Real business local time + TimeService sync status - same honest, non-decorative pattern as AiEngineStrip. */
export function TimeSyncStrip() {
  const [status, setStatus] = useState<TimeStatusResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    function load() {
      api
        .getTimeStatus()
        .then((result) => {
          if (!cancelled) setStatus(result);
        })
        // A failed read must not itself claim anything about sync state.
        .catch(() => undefined);
    }
    load();
    const interval = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  if (!status) return null;
  const { timeContext } = status;

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-lg border border-border-subtle bg-surface-2 px-3 py-2">
      <span className="flex items-center gap-1.5 text-meta font-semibold uppercase tracking-wide text-fg-muted">
        <Clock size={12} aria-hidden />
        Business time
      </span>

      <span className="flex items-center gap-1.5 text-caption text-fg-secondary">
        <span className={`h-2 w-2 shrink-0 rounded-full ${stateClass(timeContext.syncStatus)}`} aria-hidden />
        <span className="font-medium text-fg">
          {timeContext.dayOfWeek}, {timeContext.localDate} {timeContext.localDateTime.slice(11, 16)}
        </span>
        <span className="text-fg-muted">
          ({timeContext.timezone}) · {STATUS_TEXT[timeContext.syncStatus]}
        </span>
      </span>

      {timeContext.syncStatus === 'STALE' && (
        <span className="flex items-center gap-1.5 text-caption font-medium text-error">
          <AlertTriangle size={12} aria-hidden />
          Time synchronization is stale - the AI is using its best local estimate.
        </span>
      )}
      {timeContext.syncStatus === 'MANUAL_OVERRIDE' && (
        <span className="text-caption font-semibold text-info">MANUAL TIME OVERRIDE ACTIVE</span>
      )}
    </div>
  );
}
