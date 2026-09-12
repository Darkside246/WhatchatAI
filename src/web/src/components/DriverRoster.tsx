import { useCallback, useEffect, useState } from 'react';
import { Bike, Plus, RotateCcw, UserMinus } from 'lucide-react';
import { api, ApiError, type FoodDriverDto } from '../lib/api.js';

/**
 * The people who drive.
 *
 * Short on purpose - a name, a number to call them on, and what they are
 * driving, which is what somebody actually says over a pass ("give it to
 * the blue van"). Everything else about a delivery belongs to the order.
 *
 * There is no delete. A driver who has stopped working here goes inactive
 * and drops off the picker; their deliveries stay, because those are a
 * record of what happened and deleting them would rewrite it. The schema
 * enforces that rather than trusting this screen to honour it.
 */
export function DriverRoster() {
  const [drivers, setDrivers] = useState<FoodDriverDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [vehicle, setVehicle] = useState('');

  const load = useCallback(() => {
    api
      .listFoodDrivers()
      .then(({ drivers: loaded }) => setDrivers(loaded))
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load the drivers.'));
  }, []);

  useEffect(() => { load(); }, [load]);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save that.');
      load();
    } finally {
      setBusy(false);
    }
  }

  function add(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    const input = {
      name: trimmed,
      phoneNumber: phone.trim() || null,
      vehicle: vehicle.trim() || null,
    };
    setName('');
    setPhone('');
    setVehicle('');
    void run(() => api.createFoodDriver(input));
  }

  const active = (drivers ?? []).filter((driver) => driver.active);
  const past = (drivers ?? []).filter((driver) => !driver.active);

  return (
    <div>
      <p className="flex items-center gap-1.5 text-body font-semibold text-fg">
        <Bike size={15} aria-hidden />
        Drivers
      </p>
      <p className="mb-3 text-meta text-fg-muted">
        Who can take a delivery. You choose the driver on the ticket yourself — nothing is dispatched automatically.
      </p>

      {error && <p className="mb-2 rounded-lg bg-error/10 px-3 py-2 text-caption text-error">{error}</p>}

      <form onSubmit={add} className="mb-3 flex flex-wrap items-end gap-2">
        <label className="min-w-0 flex-1">
          <span className="block text-meta font-medium text-fg">Name</span>
          <input value={name} onChange={(event) => setName(event.target.value)} className={inputClass} />
        </label>
        <label className="w-32">
          <span className="block text-meta font-medium text-fg">Phone</span>
          <input value={phone} inputMode="tel" onChange={(event) => setPhone(event.target.value)} className={inputClass} />
        </label>
        <label className="w-28">
          <span className="block text-meta font-medium text-fg">Vehicle</span>
          <input value={vehicle} placeholder="blue van" onChange={(event) => setVehicle(event.target.value)} className={inputClass} />
        </label>
        <button
          type="submit"
          disabled={busy || !name.trim()}
          className="flex items-center gap-1 rounded-md bg-accent px-3 py-1.5 text-caption font-medium text-white hover:bg-accent-dim disabled:opacity-40"
        >
          <Plus size={13} aria-hidden />
          Add
        </button>
      </form>

      {drivers === null ? (
        <p className="text-caption text-fg-muted">Loading…</p>
      ) : active.length === 0 ? (
        <p className="text-caption text-fg-muted">Nobody yet. Add whoever takes your deliveries.</p>
      ) : (
        <ul className="space-y-1">
          {active.map((driver) => (
            <li key={driver.id} className="flex items-center gap-2 rounded-lg border border-border-subtle bg-surface-1 px-2.5 py-1.5">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-caption font-medium text-fg">{driver.name}</span>
                <span className="block truncate text-meta text-fg-muted">
                  {[driver.vehicle, driver.phoneNumber].filter(Boolean).join(' · ') || 'No number on file'}
                </span>
              </span>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  if (!window.confirm(`${driver.name} stops appearing when you pick a driver.\n\nTheir past deliveries are kept.`)) return;
                  void run(() => api.setFoodDriverActive(driver.id, false));
                }}
                title="They have stopped driving for you"
                className="shrink-0 rounded p-1 text-fg-muted hover:bg-surface-2 hover:text-fg disabled:opacity-40"
              >
                <UserMinus size={13} aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}

      {past.length > 0 && (
        <details className="mt-2">
          <summary className="cursor-pointer text-meta text-fg-muted">No longer driving ({past.length})</summary>
          <ul className="mt-1 space-y-1">
            {past.map((driver) => (
              <li key={driver.id} className="flex items-center gap-2 px-2.5 py-1">
                <span className="min-w-0 flex-1 truncate text-meta text-fg-muted">{driver.name}</span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void run(() => api.setFoodDriverActive(driver.id, true))}
                  title="They are driving again"
                  className="shrink-0 rounded p-1 text-fg-muted hover:bg-surface-2 hover:text-fg disabled:opacity-40"
                >
                  <RotateCcw size={12} aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

const inputClass = 'w-full rounded-md border border-border-subtle bg-surface-1 px-2.5 py-1.5 text-caption text-fg placeholder:text-fg-muted';
