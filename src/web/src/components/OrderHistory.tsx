import { useCallback, useEffect, useRef, useState } from 'react';
import { Printer, Search, X } from 'lucide-react';
import { api, ApiError, type FoodHistoryCursor, type FoodHistoryOrderDto } from '../lib/api.js';

/**
 * The orders behind the board.
 *
 * A finished ticket leaves the board, which is right - a kitchen screen
 * still showing this morning's deliveries is a screen nobody can read. But
 * the questions that come afterwards are real and constant: what was in 412,
 * what did this customer have last time, did we actually send the thing they
 * say we did not.
 *
 * Search covers the four things somebody actually knows when they come
 * looking - the number, who it was for, their phone, and what was in it.
 * "Which orders had the lamb roti" is asked far more often than any other,
 * which is why the item names are searched and not just the header.
 */

function money(cents: number, currency: string): string {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(cents / 100);
}

function when(iso: string | null): string {
  if (!iso) return '';
  return new Date(iso).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** How long it took, from the customer ordering to the ticket closing. The one number a service post-mortem actually wants. */
function took(order: FoodHistoryOrderDto): string | null {
  if (!order.closedAt) return null;
  const seconds = Math.round((new Date(order.closedAt).getTime() - new Date(order.placedAt).getTime()) / 1000);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function OrderHistory() {
  const [query, setQuery] = useState('');
  const [orders, setOrders] = useState<FoodHistoryOrderDto[] | null>(null);
  const [cursor, setCursor] = useState<FoodHistoryCursor | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /**
   * Which search the results on screen belong to.
   *
   * Typing is debounced, so two requests can be in flight when somebody
   * types quickly - and the slower one landing last would leave the results
   * for "lam" on screen under the word "lamb". Only the newest request is
   * allowed to write.
   */
  const requestId = useRef(0);

  const search = useCallback(async (term: string, from: FoodHistoryCursor | null) => {
    const id = requestId.current + 1;
    requestId.current = id;
    setBusy(true);
    try {
      const result = await api.getFoodHistory({ query: term, cursor: from, limit: 25 });
      if (requestId.current !== id) return;
      setOrders((current) => (from && current ? [...current, ...result.orders] : result.orders));
      setCursor(result.nextCursor);
      setError(null);
    } catch (err) {
      if (requestId.current !== id) return;
      setError(err instanceof ApiError ? err.message : 'Could not load the history.');
    } finally {
      if (requestId.current === id) setBusy(false);
    }
  }, []);

  // Debounced so a search runs on what somebody meant to type rather than on
  // every letter along the way.
  useEffect(() => {
    const timer = setTimeout(() => void search(query, null), query ? 250 : 0);
    return () => clearTimeout(timer);
  }, [query, search]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-border-subtle px-4 py-3 print:hidden">
        <div className="relative flex-1">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-muted" aria-hidden />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Order number, customer, phone, or an item…"
            aria-label="Search past orders"
            className="w-full rounded-lg border border-border-subtle bg-surface-2 py-2 pl-8 pr-8 text-caption text-fg placeholder:text-fg-muted focus:border-accent focus:outline-none"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              aria-label="Clear the search"
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-fg-muted hover:text-fg"
            >
              <X size={14} aria-hidden />
            </button>
          )}
        </div>
        {/* Prints whatever is on screen - one order when a search has
            narrowed to it, the day's list when it has not. A print stylesheet
            rather than a generated PDF: the thing a kitchen needs is the
            paper, and the browser already makes it. */}
        <button
          type="button"
          onClick={() => window.print()}
          className="flex shrink-0 items-center gap-1.5 rounded-lg border border-border-subtle px-3 py-2 text-caption font-medium text-fg hover:bg-surface-2"
        >
          <Printer size={14} aria-hidden />
          Print
        </button>
      </div>

      {error && <p className="border-b border-error/30 bg-error/10 px-4 py-2 text-caption text-error">{error}</p>}

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {orders === null && <p className="p-4 text-caption text-fg-muted">Loading…</p>}

        {orders !== null && orders.length === 0 && (
          <p className="p-4 text-caption text-fg-muted">
            {query ? `Nothing matches “${query}”.` : 'No orders have been finished yet.'}
          </p>
        )}

        <ul className="grid gap-2 [grid-template-columns:repeat(auto-fill,minmax(17rem,1fr))]">
          {(orders ?? []).map((order) => (
            <li
              key={order.id}
              className="break-inside-avoid rounded-lg border border-border-subtle bg-surface-1 p-3"
            >
              <div className="flex items-baseline gap-2">
                <span className="text-body font-bold text-fg">#{order.orderNumber}</span>
                {order.stage === 'CANCELLED' && (
                  <span className="rounded bg-error/15 px-1.5 py-0.5 text-meta font-semibold text-error">Cancelled</span>
                )}
                <span className="ml-auto text-meta tabular-nums text-fg-muted">{when(order.closedAt)}</span>
              </div>

              <p className="mt-0.5 truncate text-caption text-fg-secondary">
                {order.customerName ?? order.tableLabel ?? 'No name taken'}
                {took(order) && <span className="text-fg-muted"> · took {took(order)}</span>}
              </p>

              <ul className="mt-2 space-y-0.5">
                {order.items.map((item, index) => (
                  <li key={`${item.name}-${index}`} className="text-caption text-fg">
                    <span className="font-semibold tabular-nums">{item.quantity}×</span> {item.name}
                    {item.variant && <span className="text-fg-secondary"> · {item.variant}</span>}
                  </li>
                ))}
                {order.items.length === 0 && <li className="text-meta italic text-fg-muted">No items recorded.</li>}
              </ul>

              {/* Why it was cancelled, where somebody said. An order that
                  ended without food is the one most likely to be asked
                  about, and "Cancelled" on its own answers nothing. */}
              {order.cancelReason && <p className="mt-1.5 text-meta italic text-fg-muted">{order.cancelReason}</p>}

              <div className="mt-2 flex items-center gap-2 border-t border-border-subtle pt-2 text-meta text-fg-muted">
                <span className="font-medium text-fg-secondary">{money(order.totalCents, order.currency)}</span>
                <span>
                  {order.fulfilmentMethod === 'DELIVERY'
                    ? 'Delivery'
                    : order.fulfilmentMethod === 'DINE_IN'
                      ? (order.tableLabel ?? 'For here')
                      : 'Collection'}
                </span>
                {/* Only where it is a fact worth carrying forward. A paid,
                    completed order needs no label. */}
                {order.paymentState !== 'PAID' && order.paymentState !== 'NOT_REQUIRED' && (
                  <span className="ml-auto rounded bg-surface-2 px-1.5 py-0.5 font-medium">
                    {order.paymentState.toLowerCase().replace(/_/g, ' ')}
                  </span>
                )}
              </div>
            </li>
          ))}
        </ul>

        {cursor && (
          <div className="flex justify-center p-3 print:hidden">
            <button
              type="button"
              disabled={busy}
              onClick={() => void search(query, cursor)}
              className="rounded-lg border border-border-subtle px-3 py-2 text-caption font-medium text-fg hover:bg-surface-2 disabled:opacity-50"
            >
              {busy ? 'Loading…' : 'Load more'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
