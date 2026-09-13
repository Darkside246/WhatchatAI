import { useCallback, useEffect, useState } from 'react';
import { Bike, ChevronDown, ChevronRight, Copy, LogIn, Plus, RotateCcw, UserMinus } from 'lucide-react';
import { api, ApiError, type FoodDeliveryDto, type FoodDriverDto } from '../lib/api.js';

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
  /**
   * The link just issued, shown once.
   *
   * Not stored anywhere readable - the database keeps only a hash of it - so
   * if the operator navigates away before sharing it, the answer is to issue
   * a new one, which is also what invalidates the old.
   */
  const [issued, setIssued] = useState<{ driverId: string; name: string; url: string; phoneNumber: string | null } | null>(null);
  /** Which driver is opened up. One at a time - a roster with every row expanded is a list nobody can scan. */
  const [openDriverId, setOpenDriverId] = useState<string | null>(null);

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
            <li key={driver.id} className="rounded-lg border border-border-subtle bg-surface-1">
              <div className="flex items-center gap-2 px-2.5 py-1.5">
              <button
                type="button"
                onClick={() => setOpenDriverId((current) => (current === driver.id ? null : driver.id))}
                aria-expanded={openDriverId === driver.id}
                className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
              >
                {openDriverId === driver.id ? (
                  <ChevronDown size={13} className="shrink-0 text-fg-muted" aria-hidden />
                ) : (
                  <ChevronRight size={13} className="shrink-0 text-fg-muted" aria-hidden />
                )}
                <span className="min-w-0">
                  <span className="block truncate text-caption font-medium text-fg">{driver.name}</span>
                  <span className="block truncate text-meta text-fg-muted">
                    {[driver.vehicle, driver.phoneNumber].filter(Boolean).join(' · ') || 'No number on file'}
                  </span>
                </span>
              </button>
              {/* Their way in. Issued here and shared by the shop, never sent
                  by the server - putting a message through this business's
                  live WhatsApp connection on a background path is the one
                  thing worth avoiding entirely. */}
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const link = await api.createFoodDriverSignInLink(driver.id);
                    setIssued({
                      driverId: driver.id,
                      name: driver.name,
                      url: `${window.location.origin}${link.path}`,
                      phoneNumber: link.driver.phoneNumber,
                    });
                  })
                }
                title="Give this driver a sign-in link for their phone"
                className="shrink-0 rounded p-1 text-fg-muted hover:bg-surface-2 hover:text-fg disabled:opacity-40"
              >
                <LogIn size={13} aria-hidden />
              </button>
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
              </div>

              {openDriverId === driver.id && (
                <DriverDetail driver={driver} busy={busy} onSaved={load} />
              )}
            </li>
          ))}
        </ul>
      )}

      {issued && (
        <div className="mt-2 rounded-lg border border-accent/40 bg-accent-soft p-2.5">
          <p className="text-caption font-semibold text-fg">Sign-in link for {issued.name}</p>
          <p className="mt-0.5 text-meta text-fg-secondary">
            Good for one use and about half an hour. Send it however you already talk to them — it is shown once.
          </p>
          <p className="mt-1.5 break-all rounded bg-surface-1 px-2 py-1.5 text-meta text-fg">{issued.url}</p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            <button
              type="button"
              onClick={() => void navigator.clipboard?.writeText(issued.url)}
              className="flex items-center gap-1 rounded-md border border-border-subtle bg-surface-1 px-2 py-1 text-meta font-medium text-fg"
            >
              <Copy size={11} aria-hidden />
              Copy
            </button>
            {/* Opens the operator's own WhatsApp with it typed out. Their
                phone, their message - nothing goes near the server's
                connection. */}
            {issued.phoneNumber && (
              <a
                href={`https://wa.me/${issued.phoneNumber.replace(/\D/g, '')}?text=${encodeURIComponent(`Your delivery run: ${issued.url}`)}`}
                target="_blank"
                rel="noreferrer noopener"
                className="rounded-md border border-border-subtle bg-surface-1 px-2 py-1 text-meta font-medium text-fg"
              >
                Send on WhatsApp
              </a>
            )}
            <button
              type="button"
              onClick={() => setIssued(null)}
              className="ml-auto rounded-md px-2 py-1 text-meta text-fg-muted hover:text-fg"
            >
              Done
            </button>
          </div>
        </div>
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

const RUN_STATE_LABEL: Record<FoodDeliveryDto['state'], string> = {
  ASSIGNED: 'Given to them',
  COLLECTED: 'Picked up',
  DELIVERED: 'Delivered',
  FAILED: 'Did not arrive',
  RETURNED: 'Came back',
  CANCELLED: 'Cancelled',
};

/**
 * One driver, opened up: their details to correct, and what they have
 * actually been carrying.
 *
 * The runs are the half that was missing. A roster that can only add and
 * remove people answers "who drives for us" and never "did that order ever
 * get there" - which is the question actually asked about a driver, and the
 * one a customer is on the phone about.
 */
function DriverDetail({ driver, busy, onSaved }: { driver: FoodDriverDto; busy: boolean; onSaved: () => void }) {
  const [name, setName] = useState(driver.name);
  const [phone, setPhone] = useState(driver.phoneNumber ?? '');
  const [vehicle, setVehicle] = useState(driver.vehicle ?? '');
  const [runs, setRuns] = useState<FoodDeliveryDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .listFoodDriverRuns(driver.id)
      .then((result) => {
        if (!cancelled) setRuns(result.runs);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : 'Could not load their runs.');
      });
    return () => {
      cancelled = true;
    };
  }, [driver.id]);

  const dirty = name.trim() !== driver.name || phone.trim() !== (driver.phoneNumber ?? '') || vehicle.trim() !== (driver.vehicle ?? '');

  async function save() {
    if (!name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await api.updateFoodDriver(driver.id, {
        name: name.trim(),
        phoneNumber: phone.trim() || null,
        vehicle: vehicle.trim() || null,
      });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save that.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-3 border-t border-border-subtle px-2.5 py-2.5">
      {error && <p className="rounded-md bg-error/10 px-2 py-1.5 text-meta text-error">{error}</p>}

      <div className="flex flex-wrap items-end gap-2">
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
          <input value={vehicle} onChange={(event) => setVehicle(event.target.value)} className={inputClass} />
        </label>
        {/* Only once something has genuinely changed. A Save that is always
            available is a Save people press to find out what it does. */}
        <button
          type="button"
          disabled={busy || saving || !dirty || !name.trim()}
          onClick={() => void save()}
          className="rounded-md bg-accent px-3 py-1.5 text-caption font-semibold text-white disabled:opacity-40"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>

      <div>
        <p className="text-meta font-semibold uppercase tracking-wide text-fg-muted">Recent runs</p>
        {runs === null && <p className="mt-1 text-meta text-fg-muted">Loading…</p>}
        {runs !== null && runs.length === 0 && (
          <p className="mt-1 text-meta text-fg-muted">They have not been given a delivery yet.</p>
        )}
        {runs !== null && runs.length > 0 && (
          <ul className="mt-1 space-y-1">
            {runs.slice(0, 10).map((run) => (
              <li key={run.id} className="flex flex-wrap items-baseline gap-2 text-meta">
                <span className="tabular-nums text-fg-muted">
                  {new Date(run.assignedAt).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                </span>
                <span
                  className={`rounded px-1.5 py-0.5 font-semibold ${
                    run.state === 'DELIVERED'
                      ? 'bg-success/15 text-success'
                      : run.state === 'FAILED' || run.state === 'RETURNED'
                        ? 'bg-error/15 text-error'
                        : 'bg-surface-2 text-fg-secondary'
                  }`}
                >
                  {RUN_STATE_LABEL[run.state]}
                </span>
                {/* Why it did not arrive, where the driver said. "Failed" on
                    its own tells whoever reads this nothing they can act on. */}
                {run.failureReason && <span className="text-fg-muted">{run.failureReason}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
