import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Check } from 'lucide-react';
import { api, ApiError, type FoodSettingsDto } from '../lib/api.js';

/**
 * The four decisions a food business actually has to make.
 *
 * Deliberately short. Everything else about how orders behave - prices,
 * what is in stock, where they deliver - is managed where that thing
 * lives, not piled into one settings page nobody can navigate.
 *
 * Nothing here is about how the agent TALKS. That stays on the Agents
 * page, where the owner already set their persona and tone. The split is
 * the point: this page is business rules, that page is voice, and mixing
 * them is how an owner ends up trying to fix a price by rewording a prompt.
 */

const DEFAULT_NOTICE_HINT =
  'Thanks {{name}} — your order is saved as #{{order_number}}, total {{total}}. We start cooking once the payment comes through…';

export function KitchenSettings() {
  const [settings, setSettings] = useState<FoodSettingsDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');

  const load = useCallback(() => {
    api
      .getFoodSettings()
      .then(({ settings: loaded }) => {
        setSettings(loaded);
        setNotice(loaded.paymentRequiredNotice ?? '');
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load the kitchen settings.'));
  }, []);

  useEffect(() => { load(); }, [load]);

  async function save(patch: Partial<FoodSettingsDto>) {
    setSaving(true);
    setError(null);
    try {
      const { settings: updated } = await api.saveFoodSettings(patch);
      setSettings(updated);
      setSaved(true);
      // Long enough to be noticed, short enough not to linger over a
      // second change the owner is already making.
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save that.');
      // Reloaded rather than left showing a value that was never stored -
      // a toggle that looks on and is off is worse than an error.
      load();
    } finally {
      setSaving(false);
    }
  }

  if (error && !settings) return <p className="text-caption text-error">{error}</p>;
  if (!settings) return <p className="text-caption text-fg-muted">Loading…</p>;

  return (
    <div className="space-y-4">
      {error && <p className="rounded-lg bg-error/10 px-3 py-2 text-caption text-error">{error}</p>}
      {saved && (
        <p className="flex items-center gap-1.5 rounded-lg bg-success/10 px-3 py-2 text-caption text-success">
          <Check size={13} aria-hidden />
          Saved.
        </p>
      )}

      <Toggle
        label="Take payment before the kitchen starts"
        hint="Orders wait in New until the payment is recorded. A known customer can still be set to pay on delivery, and you can always release an order yourself."
        checked={settings.paymentRequiredBeforeKitchen}
        disabled={saving}
        onChange={(paymentRequiredBeforeKitchen) => void save({ paymentRequiredBeforeKitchen })}
      />

      {/* Switching the gate off is the one choice here with money attached,
          so it says what it means rather than sitting silently off. */}
      {!settings.paymentRequiredBeforeKitchen && (
        <p className="flex items-start gap-1.5 rounded-lg bg-warning/10 px-3 py-2 text-caption text-warning">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" aria-hidden />
          Orders will go straight to the kitchen whether or not they have been paid for.
        </p>
      )}

      <Toggle
        label="Table service"
        hint="Adds eating in, with a table label on the ticket. Leave this off if you only do takeaway and delivery."
        checked={settings.tableServiceEnabled}
        disabled={saving}
        onChange={(tableServiceEnabled) => void save({ tableServiceEnabled })}
      />

      {settings.paymentRequiredBeforeKitchen && (
        <div>
          <label htmlFor="payment-notice" className="block text-caption font-medium text-fg">
            What customers are told about paying
          </label>
          <p className="mb-1.5 text-meta text-fg-muted">
            Sent when an order is taken. Use <code className="text-fg-secondary">{'{{name}}'}</code>,{' '}
            <code className="text-fg-secondary">{'{{order_number}}'}</code> and{' '}
            <code className="text-fg-secondary">{'{{total}}'}</code>. Leave it empty to use our wording.
          </p>
          <textarea
            id="payment-notice"
            value={notice}
            onChange={(event) => setNotice(event.target.value)}
            onBlur={() => {
              const trimmed = notice.trim();
              if (trimmed !== (settings.paymentRequiredNotice ?? '')) void save({ paymentRequiredNotice: trimmed || null });
            }}
            rows={3}
            placeholder={DEFAULT_NOTICE_HINT}
            className="w-full rounded-lg border border-border-subtle bg-surface-1 px-3 py-2 text-caption text-fg placeholder:text-fg-muted"
          />
          <p className="mt-1 text-meta text-fg-muted">
            Never sent to a customer who pays on delivery, or to one who has already paid.
          </p>
        </div>
      )}

      <SlaFields settings={settings} disabled={saving} onSave={save} />
    </div>
  );
}

function Toggle({
  label, hint, checked, disabled, onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  disabled: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5 h-4 w-4 shrink-0 accent-accent"
      />
      <span className="min-w-0">
        <span className="block text-caption font-medium text-fg">{label}</span>
        <span className="block text-meta text-fg-muted">{hint}</span>
      </span>
    </label>
  );
}

/**
 * How long a ticket may sit before the board starts shouting.
 *
 * Empty means our defaults (ten minutes, then fifteen). Offered because a
 * bakery's custom cake and a burger have nothing in common, and a board
 * that goes red on every ticket is a board nobody looks at.
 */
function SlaFields({
  settings, disabled, onSave,
}: {
  settings: FoodSettingsDto;
  disabled: boolean;
  onSave: (patch: Partial<FoodSettingsDto>) => void;
}) {
  const [warning, setWarning] = useState(settings.slaWarningSeconds ? String(settings.slaWarningSeconds / 60) : '');
  const [breach, setBreach] = useState(settings.slaBreachSeconds ? String(settings.slaBreachSeconds / 60) : '');

  const asSeconds = (value: string): number | null => {
    const minutes = Number(value.trim());
    return value.trim() && Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes * 60) : null;
  };

  const invalid = (() => {
    const w = asSeconds(warning);
    const b = asSeconds(breach);
    return w !== null && b !== null && w >= b;
  })();

  function commit() {
    if (invalid) return;
    onSave({ slaWarningSeconds: asSeconds(warning), slaBreachSeconds: asSeconds(breach) });
  }

  return (
    <div>
      <p className="text-caption font-medium text-fg">Ticket times</p>
      <p className="mb-1.5 text-meta text-fg-muted">
        Minutes before a ticket turns amber, then red. Leave empty for 10 and 15.
      </p>
      <div className="flex items-center gap-2">
        <input
          type="number"
          min={1}
          value={warning}
          disabled={disabled}
          onChange={(event) => setWarning(event.target.value)}
          onBlur={commit}
          placeholder="10"
          aria-label="Minutes before amber"
          className="w-20 rounded-lg border border-border-subtle bg-surface-1 px-2 py-1.5 text-caption text-fg"
        />
        <span className="text-meta text-fg-muted">amber</span>
        <input
          type="number"
          min={1}
          value={breach}
          disabled={disabled}
          onChange={(event) => setBreach(event.target.value)}
          onBlur={commit}
          placeholder="15"
          aria-label="Minutes before red"
          className="w-20 rounded-lg border border-border-subtle bg-surface-1 px-2 py-1.5 text-caption text-fg"
        />
        <span className="text-meta text-fg-muted">red</span>
      </div>
      {invalid && <p className="mt-1 text-meta text-error">Amber has to come before red.</p>}
    </div>
  );
}
