import { useEffect, useState } from 'react';
import { Bike, Check, Phone, UserPlus, X } from 'lucide-react';
import { api, ApiError, type FoodBoardOrderDto, type FoodDriverDto } from '../lib/api.js';

/**
 * Who has the food, on the ticket itself.
 *
 * A board that says "out for delivery" and nothing else cannot answer the
 * only question anybody asks about an order that has left. So the driver's
 * name sits on the card, and the two things that happen to a delivery -
 * they took it, they dropped it - are one tap each.
 *
 * Nothing here dispatches. Every assignment is a person choosing a person
 * from a list, because a dispatcher that picks the wrong driver by itself
 * is worse than no dispatcher at all.
 */

const STATE_LABEL: Record<string, string> = {
  ASSIGNED: 'Assigned, not collected',
  COLLECTED: 'On the road',
  DELIVERED: 'Delivered',
  FAILED: 'Attempt failed',
  RETURNED: 'Came back',
  CANCELLED: 'Unassigned',
};

export function DeliveryControl({
  order, busy, onChanged,
}: {
  order: FoodBoardOrderDto;
  busy: boolean;
  onChanged: () => void;
}) {
  const [drivers, setDrivers] = useState<FoodDriverDto[] | null>(null);
  const [picking, setPicking] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Loaded only when somebody opens the picker: most tickets on a board
  // never need this list, and a board polls every five seconds.
  useEffect(() => {
    if (!picking || drivers !== null) return;
    api
      .listFoodDrivers(true)
      .then(({ drivers: loaded }) => setDrivers(loaded))
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load the drivers.'));
  }, [picking, drivers]);

  async function run(action: () => Promise<unknown>) {
    setWorking(true);
    setError(null);
    try {
      await action();
      setPicking(false);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save that.');
      onChanged();
    } finally {
      setWorking(false);
    }
  }

  const delivery = order.delivery;
  const disabled = busy || working;

  if (delivery) {
    return (
      <div className="mt-1.5 rounded-md bg-surface-2 px-2 py-1.5">
        <p className="flex items-center gap-1.5 text-meta font-semibold text-fg">
          <Bike size={12} aria-hidden />
          {delivery.driverName}
          {delivery.driverVehicle && <span className="font-normal text-fg-muted">· {delivery.driverVehicle}</span>}
          {delivery.driverPhone && (
            <a href={`tel:${delivery.driverPhone}`} className="ml-auto flex items-center gap-1 text-fg-muted hover:text-fg" aria-label={`Call ${delivery.driverName}`}>
              <Phone size={11} aria-hidden />
            </a>
          )}
        </p>
        <p className="mt-0.5 text-meta text-fg-muted">
          {STATE_LABEL[delivery.state] ?? delivery.state}
          {delivery.failureReason && <span className="text-error"> · {delivery.failureReason}</span>}
        </p>

        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {delivery.state === 'ASSIGNED' && (
            <>
              <button type="button" disabled={disabled} onClick={() => void run(() => api.moveFoodDelivery(delivery.id, 'COLLECTED'))} className={smallButton}>
                Collected
              </button>
              {/* Undoing a pick before anybody has moved - the wrong name
                  tapped on a list. Impossible once the food is collected,
                  because then the driver is holding it. */}
              <button type="button" disabled={disabled} onClick={() => void run(() => api.moveFoodDelivery(delivery.id, 'CANCELLED'))} className={quietButton}>
                <X size={11} aria-hidden />
                Unassign
              </button>
            </>
          )}

          {delivery.state === 'COLLECTED' && (
            <>
              <button type="button" disabled={disabled} onClick={() => void run(() => api.moveFoodDelivery(delivery.id, 'DELIVERED'))} className={smallButton}>
                <Check size={11} aria-hidden />
                Delivered
              </button>
              <button
                type="button"
                disabled={disabled}
                onClick={() => {
                  // A reason is required, because "failed" on its own tells
                  // the next person nothing they can act on - and the next
                  // person is usually standing in a shop holding food that
                  // has come back.
                  const reason = window.prompt('What went wrong?\n\nNobody in, wrong address, refused…');
                  if (!reason?.trim()) return;
                  void run(() => api.moveFoodDelivery(delivery.id, 'FAILED', { failureReason: reason.trim() }));
                }}
                className={quietButton}
              >
                Could not deliver
              </button>
            </>
          )}

          {delivery.state === 'FAILED' && (
            <>
              <button type="button" disabled={disabled} onClick={() => void run(() => api.moveFoodDelivery(delivery.id, 'COLLECTED'))} className={smallButton}>
                Trying again
              </button>
              <button type="button" disabled={disabled} onClick={() => void run(() => api.moveFoodDelivery(delivery.id, 'RETURNED'))} className={quietButton}>
                Came back
              </button>
            </>
          )}
        </div>

        {error && <p className="mt-1 text-meta text-error">{error}</p>}
      </div>
    );
  }

  if (!picking) {
    return (
      <button
        type="button"
        disabled={disabled}
        onClick={() => setPicking(true)}
        className="mt-1.5 flex items-center gap-1 rounded-md border border-border-subtle px-2 py-1 text-meta font-medium text-fg-muted hover:text-fg disabled:opacity-50"
      >
        <UserPlus size={11} aria-hidden />
        Who is taking this?
      </button>
    );
  }

  return (
    <div className="mt-1.5 rounded-md bg-surface-2 px-2 py-1.5">
      <p className="mb-1 flex items-center text-meta font-semibold text-fg">
        Who is taking this?
        <button type="button" onClick={() => setPicking(false)} aria-label="Close" className="ml-auto text-fg-muted hover:text-fg">
          <X size={12} aria-hidden />
        </button>
      </p>

      {drivers === null && !error && <p className="text-meta text-fg-muted">Loading…</p>}
      {drivers !== null && drivers.length === 0 && (
        <p className="text-meta text-fg-muted">Nobody is set up to drive yet. Add your drivers under Setup.</p>
      )}

      <div className="flex flex-wrap gap-1">
        {(drivers ?? []).map((driver) => (
          <button
            key={driver.id}
            type="button"
            disabled={disabled}
            onClick={() => void run(() => api.assignFoodDriver(order.id, driver.id))}
            className="rounded-md border border-border-subtle bg-surface-0 px-2 py-1 text-meta font-medium text-fg hover:bg-surface-1 disabled:opacity-50"
          >
            {driver.name}
            {driver.vehicle && <span className="ml-1 font-normal text-fg-muted">{driver.vehicle}</span>}
          </button>
        ))}
      </div>

      {error && <p className="mt-1 text-meta text-error">{error}</p>}
    </div>
  );
}

const smallButton =
  'flex items-center gap-1 rounded-md bg-accent px-2 py-1 text-meta font-semibold text-white hover:bg-accent-dim disabled:opacity-50';
const quietButton =
  'flex items-center gap-1 rounded-md border border-border-subtle px-2 py-1 text-meta font-medium text-fg-muted hover:text-fg disabled:opacity-50';
