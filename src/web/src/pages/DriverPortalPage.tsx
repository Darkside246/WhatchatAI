import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Bike, Check, LogOut, MapPin, Navigation, Phone, RotateCcw, X } from 'lucide-react';
import { api, ApiError, type DriverRunStop, type DriverRunResponse } from '../lib/api.js';

/**
 * What the driver sees.
 *
 * Built for one hand, in a van, in the sun. Everything is large, the
 * primary action on each stop is a single obvious button, and nothing on
 * this page asks the driver to read a table.
 *
 * Deliberately not part of the workspace. A driver is not a member of the
 * business - they get their own run and nothing else about the shop, its
 * takings, its customers or its other drivers - and the way that is
 * guaranteed is that this page talks to /api/driver, which is a separate
 * principal, rather than to any workspace route.
 */

function money(cents: number, currency: string): string {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(cents / 100);
}

/** How long the customer has been waiting. The number a driver actually wants. */
function waiting(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function StopCard({ stop, busy, onMove }: { stop: DriverRunStop; busy: boolean; onMove: (state: string, reason?: string) => void }) {
  const late = stop.ageSeconds >= 45 * 60;
  const mapUrl =
    stop.deliveryLatitude !== null && stop.deliveryLongitude !== null
      ? `https://www.openstreetmap.org/?mlat=${stop.deliveryLatitude}&mlon=${stop.deliveryLongitude}#map=17/${stop.deliveryLatitude}/${stop.deliveryLongitude}`
      : null;

  return (
    <article className="overflow-hidden rounded-xl border border-border-subtle bg-surface-1">
      <div className={`flex items-baseline gap-2 px-4 py-2.5 text-kds-band-fg ${late ? 'bg-kds-late' : 'bg-kds-ontime'}`}>
        <span className="text-body font-bold">
          {stop.position !== null ? `${stop.position}. ` : ''}#{stop.orderNumber}
        </span>
        <span className="ml-auto text-caption font-semibold tabular-nums">{waiting(stop.ageSeconds)} waiting</span>
      </div>

      <div className="space-y-3 p-4">
        <div>
          <p className="text-body font-semibold text-fg">{stop.customerName ?? 'No name given'}</p>
          {stop.deliveryAddress ? (
            <p className="text-caption text-fg-secondary">{stop.deliveryAddress}</p>
          ) : (
            /* Said loudly rather than left blank: an address the route could
               not use is exactly the one that goes wrong. */
            <p className="flex items-center gap-1.5 text-caption font-semibold text-warning">
              <AlertTriangle size={14} aria-hidden />
              No address on this one — call before you set off.
            </p>
          )}
          {stop.deliveryNotes && <p className="mt-0.5 text-caption italic text-fg-muted">{stop.deliveryNotes}</p>}
        </div>

        {stop.allergenNotes && (
          <p className="flex items-start gap-2 rounded-lg bg-error/15 px-3 py-2 text-caption font-semibold text-error">
            <AlertTriangle size={15} className="mt-0.5 shrink-0" aria-hidden />
            {stop.allergenNotes}
          </p>
        )}

        <ul className="space-y-1">
          {stop.items.map((item, index) => (
            <li key={`${item.name}-${index}`} className="text-caption text-fg">
              <span className="font-semibold tabular-nums">{item.quantity}×</span> {item.name}
            </li>
          ))}
        </ul>

        <div className="flex items-center gap-2 text-caption">
          <span className="font-semibold text-fg">{money(stop.totalCents, stop.currency)}</span>
          {/* The one money fact a driver needs: is there anything to collect. */}
          {stop.paymentState === 'PAID' || stop.paymentState === 'NOT_REQUIRED' ? (
            <span className="rounded bg-success/15 px-2 py-0.5 font-semibold text-success">Paid</span>
          ) : (
            <span className="rounded bg-warning/20 px-2 py-0.5 font-semibold text-warning">Collect on delivery</span>
          )}
        </div>

        <div className="flex flex-wrap gap-2">
          {stop.customerPhone && (
            <a
              href={`tel:${stop.customerPhone.replace(/\s+/g, '')}`}
              className="flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-lg border border-border-subtle px-3 text-caption font-semibold text-fg"
            >
              <Phone size={15} aria-hidden />
              Call
            </a>
          )}
          {mapUrl && (
            <a
              href={mapUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-lg border border-border-subtle px-3 text-caption font-semibold text-fg"
            >
              <Navigation size={15} aria-hidden />
              Map
            </a>
          )}
        </div>

        {/* One obvious next action, never a row of equal-looking buttons. */}
        {stop.state === 'ASSIGNED' && (
          <button
            type="button"
            disabled={busy}
            onClick={() => onMove('COLLECTED')}
            className="min-h-12 w-full rounded-lg bg-accent text-body font-semibold text-white disabled:opacity-50"
          >
            Picked it up
          </button>
        )}

        {(stop.state === 'COLLECTED' || stop.state === 'FAILED') && (
          <div className="flex gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => onMove('DELIVERED')}
              className="flex min-h-12 flex-1 items-center justify-center gap-1.5 rounded-lg bg-success text-body font-semibold text-white disabled:opacity-50"
            >
              <Check size={17} aria-hidden />
              Delivered
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                // A reason is required by the server, because "failed" on its
                // own tells the shop nothing they can do anything about.
                const reason = window.prompt('What happened? The shop sees this.');
                if (reason?.trim()) onMove('FAILED', reason.trim());
              }}
              className="flex min-h-12 items-center justify-center gap-1.5 rounded-lg border border-error/60 px-4 text-caption font-semibold text-error disabled:opacity-50"
            >
              <X size={16} aria-hidden />
              Problem
            </button>
          </div>
        )}

        {stop.state === 'FAILED' && (
          <p className="text-caption font-semibold text-warning">
            Marked as a problem — still in the van. Try again or take it back to the shop.
          </p>
        )}
      </div>
    </article>
  );
}

export function DriverPortalPage() {
  const [run, setRun] = useState<DriverRunResponse | null>(null);
  const [status, setStatus] = useState<'signing-in' | 'signed-out' | 'ready'>('signing-in');
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setRun(await api.getDriverRun());
      setStatus('ready');
      setError(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setStatus('signed-out');
        return;
      }
      setError(err instanceof ApiError ? err.message : 'Could not load your run.');
    }
  }, []);

  // A link is redeemed once, then removed from the address bar - leaving it
  // there means the next person to pick up the phone can read the key out of
  // the browser history.
  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get('token');
    if (!token) {
      void load();
      return;
    }
    void (async () => {
      try {
        await api.signInDriver(token);
      } catch {
        // Falls through to load(), which reports "signed out" honestly
        // rather than claiming the link failed for a reason we do not know.
      }
      window.history.replaceState(null, '', '/driver');
      await load();
    })();
  }, [load]);

  // Refreshed while the driver has the screen open, so a stop the shop
  // assigns mid-run appears without them thinking to reload.
  useEffect(() => {
    if (status !== 'ready') return;
    const timer = setInterval(() => void load(), 20000);
    return () => clearInterval(timer);
  }, [status, load]);

  async function move(stop: DriverRunStop, state: string, failureReason?: string) {
    setBusyId(stop.deliveryId);
    setError(null);
    try {
      await api.moveDriverStop(stop.deliveryId, state, failureReason);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save that.');
      await load();
    } finally {
      setBusyId(null);
    }
  }

  if (status === 'signing-in') {
    return <div className="flex h-full items-center justify-center bg-surface-0 text-body text-fg-muted">Signing you in…</div>;
  }

  if (status === 'signed-out') {
    return (
      <div className="flex h-full items-center justify-center bg-surface-0 p-6">
        <div className="max-w-sm text-center">
          <Bike size={28} className="mx-auto mb-3 text-fg-muted" aria-hidden />
          <h1 className="text-h3 font-semibold text-fg">You are signed out</h1>
          <p className="mt-2 text-caption text-fg-secondary">
            Ask the shop to send you a new sign-in link. Links are good for one use, so the last one you tapped will not
            work again.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-surface-0">
      <header className="flex items-center gap-3 border-b border-border-subtle bg-surface-1 px-4 py-3">
        <div className="min-w-0">
          <h1 className="truncate text-body font-semibold text-fg">{run?.driver.name ?? 'Your run'}</h1>
          <p className="text-meta text-fg-muted">{run?.summary}</p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          aria-label="Refresh your run"
          className="ml-auto flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-border-subtle text-fg-muted"
        >
          <RotateCcw size={17} aria-hidden />
        </button>
        <button
          type="button"
          onClick={() => void api.signOutDriver().then(() => setStatus('signed-out'))}
          aria-label="Sign out"
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-border-subtle text-fg-muted"
        >
          <LogOut size={17} aria-hidden />
        </button>
      </header>

      {error && <p className="border-b border-error/30 bg-error/10 px-4 py-2 text-caption text-error">{error}</p>}

      {/* Said plainly. A driver told "4.2 km" who finds it is 9 stops of
          winding road stops believing anything else on this screen. */}
      {run && !run.startedFromShop && run.stops.length > 1 && (
        <p className="border-b border-border-subtle px-4 py-2 text-meta text-fg-muted">
          Ordered nearest-first between the stops. Set a delivery zone in the shop's settings and this will measure from
          the shop instead.
        </p>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {run && run.stops.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <MapPin size={28} className="mb-3 text-fg-muted opacity-50" aria-hidden />
            <p className="text-body font-medium text-fg">Nothing to deliver right now</p>
            <p className="mt-1 text-caption text-fg-muted">This will fill up as the shop puts orders on you.</p>
          </div>
        )}

        <div className="space-y-3">
          {(run?.stops ?? []).map((stop) => (
            <StopCard
              key={stop.deliveryId}
              stop={stop}
              busy={busyId === stop.deliveryId}
              onMove={(state, reason) => void move(stop, state, reason)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
