import { useEffect, useState } from 'react';
import { History, Search, ChevronDown, Bot, User, Cpu } from 'lucide-react';
import { api, ApiError, type ActivityLogEvent, type ActivityLogFilters } from '../lib/api.js';

const ACTOR_ICON: Record<ActivityLogEvent['actor']['kind'], typeof Bot> = { AGENT: Bot, USER: User, SYSTEM: Cpu };

function formatEventType(eventType: string): string {
  return eventType.replace(/[._]/g, ' ');
}

function EventRow({ event }: { event: ActivityLogEvent }) {
  const [expanded, setExpanded] = useState(false);
  const ActorIcon = ACTOR_ICON[event.actor.kind];
  const hasPayload = Object.keys(event.payload).length > 0;

  return (
    <div className="border-b border-border-subtle last:border-0">
      <button
        type="button"
        onClick={() => hasPayload && setExpanded((v) => !v)}
        className={`flex w-full items-start gap-3 px-4 py-3 text-left ${hasPayload ? 'hover:bg-surface-2' : 'cursor-default'}`}
      >
        <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-surface-2 text-fg-muted">
          <ActorIcon size={13} aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="text-body font-medium capitalize text-fg">{formatEventType(event.eventType)}</span>
            <span className="text-meta text-fg-muted">by {event.actor.kind.toLowerCase()} {event.actor.id}</span>
          </div>
          <p className="mt-0.5 text-caption text-fg-muted">{new Date(event.occurredAt).toLocaleString()}</p>
        </div>
        {hasPayload && (
          <ChevronDown size={14} className={`mt-1 shrink-0 text-fg-muted transition-transform ${expanded ? 'rotate-180' : ''}`} aria-hidden />
        )}
      </button>
      {expanded && hasPayload && (
        <pre className="mx-4 mb-3 overflow-x-auto rounded-lg bg-surface-2 p-3 text-meta text-fg-secondary">
          {JSON.stringify(event.payload, null, 2)}
        </pre>
      )}
    </div>
  );
}

export function ActivityLogPage() {
  const [events, setEvents] = useState<ActivityLogEvent[]>([]);
  const [nextCursor, setNextCursor] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [eventType, setEventType] = useState('');
  const [actorKind, setActorKind] = useState<'' | ActivityLogEvent['actor']['kind']>('');

  function activeFilters(): ActivityLogFilters {
    const filters: ActivityLogFilters = {};
    if (eventType.trim()) filters.eventType = eventType.trim();
    if (actorKind) filters.actorKind = actorKind;
    return filters;
  }

  function load() {
    setLoading(true);
    setError(null);
    api
      .getActivityLog(activeFilters())
      .then((res) => {
        setEvents(res.events);
        setNextCursor(res.nextCursor);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load the activity log.'))
      .finally(() => setLoading(false));
  }

  async function loadMore() {
    if (nextCursor === null) return;
    setLoadingMore(true);
    try {
      const res = await api.getActivityLog({ ...activeFilters(), beforeSequence: nextCursor });
      setEvents((current) => [...current, ...res.events]);
      setNextCursor(res.nextCursor);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load more.');
    } finally {
      setLoadingMore(false);
    }
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [eventType, actorKind]);

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="mx-auto max-w-3xl">
        <div className="flex items-center gap-2">
          <History size={18} className="text-fg-muted" aria-hidden />
          <h1 className="text-title font-semibold text-fg">Activity log</h1>
        </div>
        <p className="mt-1 text-body text-fg-muted">
          Every real action your AI agents and team have taken - approvals, executed actions, and more, in order.
        </p>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[180px]">
            <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-muted" aria-hidden />
            <input
              type="text"
              value={eventType}
              onChange={(e) => setEventType(e.target.value)}
              placeholder="Filter by event type, e.g. maintenance.create_work_order"
              className="w-full rounded-lg border border-border-subtle bg-surface-1 py-1.5 pl-8 pr-3 text-caption text-fg placeholder:text-fg-muted focus:border-accent focus:outline-none"
            />
          </div>
          <select
            value={actorKind}
            onChange={(e) => setActorKind(e.target.value as typeof actorKind)}
            className="rounded-lg border border-border-subtle bg-surface-1 px-3 py-1.5 text-caption text-fg focus:border-accent focus:outline-none"
          >
            <option value="">All actors</option>
            <option value="AGENT">AI agents</option>
            <option value="USER">Team members</option>
            <option value="SYSTEM">System</option>
          </select>
        </div>

        {error && <p className="mt-4 text-caption text-error">{error}</p>}

        <div className="mt-4 overflow-hidden rounded-xl border border-border-subtle bg-surface-1">
          {loading && <p className="p-4 text-caption text-fg-muted">Loading…</p>}
          {!loading && events.length === 0 && (
            <p className="p-6 text-center text-caption text-fg-muted">No activity recorded yet.</p>
          )}
          {events.map((event) => (
            <EventRow key={event.id} event={event} />
          ))}
        </div>

        {!loading && nextCursor !== null && (
          <button
            type="button"
            onClick={() => void loadMore()}
            disabled={loadingMore}
            className="mt-3 w-full rounded-lg border border-border-subtle py-2 text-caption font-medium text-fg-secondary hover:bg-surface-2 disabled:opacity-50"
          >
            {loadingMore ? 'Loading…' : 'Load more'}
          </button>
        )}
      </div>
    </div>
  );
}
