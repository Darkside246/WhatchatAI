import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Bike, ChevronLeft, ChevronRight, Eye, HandCoins, MessageSquare, Timer } from 'lucide-react';
import { Link } from 'react-router-dom';
import { api, ApiError, type FoodServiceSummaryResponse } from '../lib/api.js';

/**
 * What happened today.
 *
 * Read standing at the pass at closing time, not sitting down with a report,
 * so it is a handful of large figures and one list of things still to chase
 * - never a table somebody has to interpret.
 *
 * The day is the business's own, with its own rollover: a kitchen that
 * closes at one in the morning has ONE service, and cutting it at midnight
 * splits a Friday night across two reports that agree with neither. The
 * header says which day and which zone it used, because a number whose
 * window is implied is a number two people will read differently.
 */

function money(cents: number, currency: string): string {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(cents / 100);
}

/** Yesterday/tomorrow on a plain YYYY-MM-DD, without dragging the browser's zone into it. */
function shiftDay(day: string, days: number): string {
  const [year, month, date] = day.split('-').map(Number);
  const moved = new Date(Date.UTC(year!, (month ?? 1) - 1, (date ?? 1) + days));
  return moved.toISOString().slice(0, 10);
}

function Figure({ label, value, hint, tone = 'plain' }: { label: string; value: string; hint?: string; tone?: 'plain' | 'warn' | 'good' }) {
  return (
    <div className="rounded-xl border border-border-subtle bg-surface-1 p-3">
      <p className="text-meta font-medium uppercase tracking-wide text-fg-muted">{label}</p>
      <p
        className={`mt-0.5 text-h2 font-semibold tabular-nums ${
          tone === 'warn' ? 'text-warning' : tone === 'good' ? 'text-success' : 'text-fg'
        }`}
      >
        {value}
      </p>
      {hint && <p className="mt-0.5 text-meta text-fg-muted">{hint}</p>}
    </div>
  );
}

export function ServiceSummary() {
  const [day, setDay] = useState<string | null>(null);
  const [data, setData] = useState<FoodServiceSummaryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (forDay: string | null) => {
    setLoading(true);
    try {
      // With no day, the server works out the business's current service day
      // from its own timezone and rollover - the browser's idea of "today"
      // is not the kitchen's.
      const result = await api.getFoodServiceSummary(forDay ? { day: forDay } : {});
      setData(result);
      setDay(result.day);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load the summary.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(null);
  }, [load]);

  const summary = data?.summary;
  const currency = summary?.money.currency ?? 'USD';

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-border-subtle px-4 py-2.5 print:hidden">
        <button
          type="button"
          onClick={() => day && void load(shiftDay(day, -1))}
          aria-label="The day before"
          className="flex h-9 w-9 items-center justify-center rounded-lg border border-border-subtle text-fg-muted hover:text-fg"
        >
          <ChevronLeft size={16} aria-hidden />
        </button>
        <div className="min-w-0 text-center">
          <p className="text-caption font-semibold text-fg">{data?.day ?? '—'}</p>
          {/* The window, stated. Two people reading "today" differently is
              how a disputed figure starts. */}
          <p className="text-meta text-fg-muted">
            {data ? `${data.timezone}${data.rolloverHour > 0 ? ` · day starts ${data.rolloverHour}:00` : ''}` : ''}
          </p>
        </div>
        <button
          type="button"
          onClick={() => day && void load(shiftDay(day, 1))}
          aria-label="The day after"
          className="flex h-9 w-9 items-center justify-center rounded-lg border border-border-subtle text-fg-muted hover:text-fg"
        >
          <ChevronRight size={16} aria-hidden />
        </button>
        <button
          type="button"
          onClick={() => void load(null)}
          className="ml-auto rounded-lg border border-border-subtle px-3 py-1.5 text-caption font-medium text-fg hover:bg-surface-2"
        >
          Today
        </button>
      </div>

      {error && <p className="border-b border-error/30 bg-error/10 px-4 py-2 text-caption text-error">{error}</p>}

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {loading && !summary && <p className="p-4 text-caption text-fg-muted">Loading…</p>}

        {summary && (
          <>
            <div className="grid gap-2 [grid-template-columns:repeat(auto-fill,minmax(9rem,1fr))]">
              <Figure label="Orders" value={String(summary.orders.taken)} hint={`${summary.orders.completed} finished · ${summary.orders.cancelled} cancelled`} />
              <Figure label="Sold" value={money(summary.money.soldCents, currency)} hint="Cancelled orders excluded" />
              <Figure
                label="Collected"
                value={money(summary.money.collectedCents, currency)}
                /* The honest caveat, on the screen rather than only in the
                   code: money taken at the counter never passed through us. */
                hint="Through AURA only"
              />
              <Figure
                label="Still owed"
                value={money(summary.money.outstandingCents, currency)}
                tone={summary.money.outstandingCents > 0 ? 'warn' : 'good'}
              />
            </div>

            <div className="mt-2 grid gap-2 [grid-template-columns:repeat(auto-fill,minmax(9rem,1fr))]">
              <Figure
                label="Late"
                value={String(summary.service.lateOrders)}
                hint="Past your own time limit"
                tone={summary.service.lateOrders > 0 ? 'warn' : 'good'}
              />
              <Figure
                label="Typical"
                value={summary.service.medianMinutesToLeave !== null ? `${summary.service.medianMinutesToLeave} min` : '—'}
                hint="Order to leaving the pass"
              />
              <Figure
                label="Slowest"
                value={summary.service.slowestMinutesToLeave !== null ? `${summary.service.slowestMinutesToLeave} min` : '—'}
              />
              {summary.delivery.runs > 0 && (
                <Figure
                  label="Deliveries"
                  value={String(summary.delivery.runs)}
                  hint={`${summary.delivery.delivered} delivered · ${summary.delivery.failed} did not`}
                  tone={summary.delivery.failed > 0 ? 'warn' : 'plain'}
                />
              )}
            </div>

            {summary.money.byMethod.length > 0 && (
              <section className="mt-3 rounded-xl border border-border-subtle bg-surface-1 p-3">
                <h3 className="flex items-center gap-1.5 text-caption font-semibold text-fg">
                  <HandCoins size={14} aria-hidden />
                  How they paid
                </h3>
                <ul className="mt-2 space-y-1">
                  {summary.money.byMethod.map((row) => (
                    <li key={row.method} className="flex items-baseline gap-2 text-caption">
                      <span className="text-fg">{row.method.replace(/_/g, ' ').toLowerCase()}</span>
                      <span className="text-meta text-fg-muted">
                        {row.orders} order{row.orders === 1 ? '' : 's'}
                      </span>
                      <span className="ml-auto font-medium tabular-nums text-fg">{money(row.cents, currency)}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {/* Only when there is something to act on. A zero here is not
                news and a card saying "0 unchecked" is a card people learn
                to skip past, taking the real ones with it. */}
            {summary.qc.unacknowledged > 0 && (
              <p className="mt-3 flex items-center gap-2 rounded-xl border border-warning/40 bg-warning/10 px-3 py-2.5 text-caption text-warning">
                <Eye size={15} className="shrink-0" aria-hidden />
                {summary.qc.unacknowledged} photo check{summary.qc.unacknowledged === 1 ? '' : 's'} nobody cleared, of{' '}
                {summary.qc.flagged} flagged.
              </p>
            )}

            {summary.delivery.failed > 0 && (
              <p className="mt-2 flex items-center gap-2 rounded-xl border border-warning/40 bg-warning/10 px-3 py-2.5 text-caption text-warning">
                <Bike size={15} className="shrink-0" aria-hidden />
                {summary.delivery.failed} deliver{summary.delivery.failed === 1 ? 'y' : 'ies'} did not arrive.
              </p>
            )}
          </>
        )}

        {data && data.outstanding.length > 0 && (
          <section className="mt-3">
            <h3 className="flex items-center gap-1.5 px-1 text-caption font-semibold text-fg">
              <AlertTriangle size={14} className="text-warning" aria-hidden />
              Still to chase ({data.outstanding.length})
            </h3>
            {/* Deliberately not limited to the day above: an order unpaid
                from Tuesday is still unpaid on Friday, and a summary that
                forgets it is how a debt quietly becomes a write-off. */}
            <p className="px-1 text-meta text-fg-muted">Everything outstanding, not just today's.</p>

            <ul className="mt-2 space-y-1.5">
              {data.outstanding.map((order) => (
                <li key={order.orderId} className="flex flex-wrap items-center gap-2 rounded-lg border border-border-subtle bg-surface-1 px-3 py-2">
                  <span className="text-caption font-bold text-fg">#{order.orderNumber}</span>
                  <span className="min-w-0 flex-1 truncate text-caption text-fg-secondary">
                    {order.customerName ?? order.customerPhone ?? 'No name taken'}
                  </span>
                  <span className="text-caption font-medium tabular-nums text-fg">{money(order.totalCents, order.currency)}</span>
                  <span className="rounded bg-surface-2 px-1.5 py-0.5 text-meta text-fg-muted">
                    {order.paymentState.toLowerCase().replace(/_/g, ' ')}
                  </span>
                  {/* Straight to the conversation it came from, because the
                      next thing an owner does with this list is ask. */}
                  {order.chatId && (
                    <Link
                      to={`/food/operations/chat/${order.chatId}`}
                      className="flex items-center gap-1 rounded-md border border-border-subtle px-2 py-1 text-meta font-medium text-fg hover:bg-surface-2"
                    >
                      <MessageSquare size={11} aria-hidden />
                      Chat
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}

        {data && data.outstanding.length === 0 && summary && summary.orders.taken > 0 && (
          <p className="mt-3 flex items-center gap-2 rounded-xl border border-success/40 bg-success/10 px-3 py-2.5 text-caption text-success">
            <Timer size={15} className="shrink-0" aria-hidden />
            Nothing outstanding. Everything taken has been paid for or written off.
          </p>
        )}

        {summary && summary.orders.taken === 0 && (
          <p className="p-6 text-center text-caption text-fg-muted">No orders were taken on this day.</p>
        )}
      </div>
    </div>
  );
}
