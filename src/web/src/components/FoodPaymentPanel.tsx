import { useEffect, useState } from 'react';
import { HandCoins, Loader2, Undo2, X } from 'lucide-react';
import { api, ApiError, type FoodBoardOrderDto, type FoodPaymentRequestDto } from '../lib/api.js';

/**
 * Taking the money in person, and the record of every time it was asked for.
 *
 * The board could ask a customer to pay over WhatsApp and confirm that a
 * request had been settled, and that was all - both of which need a chat.
 * An order taken at the counter has no chat by definition, so somebody
 * handing over cash had no way to be recorded as having paid at all: the
 * ticket sat UNPAID through service and into the day's takings.
 *
 * Refunds had the same hole from the other end. An order refunded after the
 * fact stayed PAID for good, so the day's money never agreed with the till.
 *
 * The asks are listed here rather than only the latest one because "we
 * asked four times" is the thing worth knowing before asking a fifth.
 */

/** What the till actually offers. Matches the server's own list. */
const METHODS: { key: 'CASH' | 'CARD' | 'BANK_TRANSFER' | 'MOBILE' | 'ON_ACCOUNT' | 'OTHER'; label: string }[] = [
  { key: 'CASH', label: 'Cash' },
  { key: 'CARD', label: 'Card' },
  { key: 'BANK_TRANSFER', label: 'Transfer' },
  { key: 'MOBILE', label: 'Mobile' },
  { key: 'ON_ACCOUNT', label: 'On account' },
  { key: 'OTHER', label: 'Other' },
];

function money(cents: number, currency: string): string {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(cents / 100);
}

export function FoodPaymentPanel({
  order,
  onClose,
  onChanged,
}: {
  order: FoodBoardOrderDto;
  onClose: () => void;
  onChanged: () => void | Promise<void>;
}) {
  const [requests, setRequests] = useState<FoodPaymentRequestDto[] | null>(null);
  const [method, setMethod] = useState<(typeof METHODS)[number]['key']>('CASH');
  const [reference, setReference] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { requests: fetched } = await api.listFoodPaymentRequests(order.id);
        if (!cancelled) setRequests(fetched);
      } catch {
        // The history is context, not the job. Failing to load it must not
        // stop somebody recording the cash in their hand.
        if (!cancelled) setRequests([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [order.id]);

  async function record(state: 'PAID' | 'REFUNDED') {
    setBusy(true);
    setError(null);
    try {
      await api.recordFoodPayment(order.id, {
        state,
        method,
        ...(reference.trim() ? { reference: reference.trim() } : {}),
      });
      await onChanged();
      onClose();
    } catch (err) {
      // Marking money as settled needs food.approve, so a 403 here is a
      // real answer rather than a bug - the message says whose call it is.
      setError(err instanceof ApiError ? err.message : 'Could not record that.');
    } finally {
      setBusy(false);
    }
  }

  const settled = order.paymentState === 'PAID' || order.paymentState === 'WAIVED';

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4" role="dialog" aria-modal="true">
      <div className="flex max-h-[85vh] w-full max-w-sm flex-col overflow-y-auto rounded-t-2xl bg-surface-1 p-4 sm:rounded-2xl">
        <div className="flex items-start gap-2">
          <div className="min-w-0">
            <p className="truncate text-body font-semibold text-fg">Payment · #{order.orderNumber}</p>
            <p className="truncate text-meta text-fg-muted">
              {money(order.totalCents, order.currency)} · {order.paymentState.toLowerCase().replace(/_/g, ' ')}
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="ml-auto shrink-0 rounded p-1 text-fg-muted hover:text-fg">
            <X size={16} aria-hidden />
          </button>
        </div>

        {error && <p className="mt-2 rounded bg-error/10 px-2 py-1 text-caption text-error">{error}</p>}

        <p className="mt-3 text-meta font-medium uppercase tracking-wide text-fg-muted">How they paid</p>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {METHODS.map((option) => (
            <button
              key={option.key}
              type="button"
              onClick={() => setMethod(option.key)}
              className={`rounded-full px-2.5 py-1 text-caption font-medium transition ${
                method === option.key ? 'bg-accent text-white' : 'bg-surface-2 text-fg-secondary hover:text-fg'
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>

        <label className="mt-3 block text-meta font-medium uppercase tracking-wide text-fg-muted">
          Reference (optional)
          <input
            value={reference}
            onChange={(event) => setReference(event.target.value)}
            placeholder="Receipt or transfer number"
            className="mt-1 w-full rounded-lg border border-border-subtle bg-surface-2 px-2.5 py-1.5 text-caption text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          />
        </label>

        <div className="mt-4 flex flex-wrap gap-2">
          {!settled && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void record('PAID')}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-success px-3 py-2 text-caption font-semibold text-white hover:opacity-90 disabled:opacity-50"
            >
              {busy ? <Loader2 size={13} className="animate-spin" aria-hidden /> : <HandCoins size={13} aria-hidden />}
              Mark paid
            </button>
          )}
          {/* Only against money that was actually taken. Offering a refund on
              an order nobody paid for is offering to invent a transaction. */}
          {order.paymentState === 'PAID' && (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                if (!window.confirm(`Record #${order.orderNumber} as refunded?\n\nThis is the record of a refund you have already given — it does not move any money by itself.`)) return;
                void record('REFUNDED');
              }}
              className="flex items-center justify-center gap-1.5 rounded-lg border border-border-subtle px-3 py-2 text-caption font-medium text-fg-secondary hover:bg-surface-2 disabled:opacity-50"
            >
              <Undo2 size={13} aria-hidden />
              Refunded
            </button>
          )}
        </div>

        <p className="mt-4 text-meta font-medium uppercase tracking-wide text-fg-muted">Asked for</p>
        {requests === null && <p className="mt-1 text-caption text-fg-muted">Loading…</p>}
        {requests !== null && requests.length === 0 && (
          <p className="mt-1 text-caption text-fg-muted">Never asked — this order was settled in person, or has not been chased.</p>
        )}
        <div className="mt-1 space-y-1">
          {(requests ?? []).map((request) => (
            <div key={request.id} className="flex items-center gap-2 rounded-lg bg-surface-2 px-2.5 py-1.5">
              <span className="min-w-0 flex-1 truncate text-caption text-fg-secondary">
                {new Date(request.requestedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                {' · '}
                {request.method.toLowerCase().replace(/_/g, ' ')}
              </span>
              <span className={`shrink-0 text-meta font-semibold ${request.confirmedAt ? 'text-success' : 'text-fg-muted'}`}>
                {request.confirmedAt ? 'Settled' : 'Open'}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
