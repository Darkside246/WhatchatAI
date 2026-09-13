import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Bot, Check, HandPlatter, UserRound } from 'lucide-react';
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

/** Real examples of the kind of thing a menu cannot say, not filler. */
const RULES_HINT =
  'We need an hour on anything from the grill.\nNo substitutions on the combos.\nDelivery is two meals minimum after 8pm.\nIf somebody asks for something we do not have, offer the closest thing on the menu.';

const DEFAULT_NOTICE_HINT =
  'Thanks {{name}} — your order is saved as #{{order_number}}, total {{total}}. We start cooking once the payment comes through…';

export function KitchenSettings() {
  const [settings, setSettings] = useState<FoodSettingsDto | null>(null);
  /**
   * How many dishes exist, purely so this screen can tell the truth about
   * whether the assistant can take an order at all.
   *
   * The setting on its own is not the whole answer: with no menu there is
   * nothing to quote from, so the tools are withheld regardless of what is
   * chosen here. An owner who sets this to FULL and then waits for orders
   * that never come deserves to be told which of the two halves is
   * missing. null means "not counted yet", never "none".
   */
  const [menuCount, setMenuCount] = useState<number | null>(null);
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

  useEffect(() => {
    // Best-effort: a failed count leaves the panel saying nothing about
    // the menu rather than claiming there isn't one.
    api.getFoodMenu().then(({ items }) => setMenuCount(items.length)).catch(() => undefined);
  }, []);

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

      <OrderTakingSection
        settings={settings}
        menuCount={menuCount}
        disabled={saving}
        onSave={save}
      />

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

      {/* A third eye at the pass. Off by default: this is help a business
          opts into, not a step imposed on a kitchen that never asked for
          one - and a kitchen made to photograph every order will find a
          way not to. */}
      <Toggle
        label="Check orders against a photo before they leave"
        hint="Your agent reads a photo of the packed order and tells you if it can SEE something the order said to leave out — ketchup on a burger ordered without it. It can never tell you something is missing, and it never says it can: food hides under buns and lids. Photograph from the side, not from above."
        checked={settings.qcVisionEnabled}
        disabled={saving}
        onChange={(qcVisionEnabled) => void save({ qcVisionEnabled })}
      />

      <Toggle
        label="Require a photo before an order leaves the pass"
        hint="An order cannot be sent out until somebody photographs it. Anybody can still send one out without a photo — they just have to say why, and it is recorded against the order."
        checked={settings.qcPhotoRequired}
        disabled={saving}
        onChange={(qcPhotoRequired) => void save({ qcPhotoRequired })}
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

/**
 * Who takes the order.
 *
 * This is the question owners actually ask first - "where do I set up the
 * AI to take my orders?" - and until now it had no answer, because the
 * ordering tools were handed to the agent automatically the moment a menu
 * existed. That made the behaviour invisible and impossible to turn off.
 *
 * Three choices rather than a switch, because a kitchen genuinely has
 * three positions and the middle one is the one most owners want: let it
 * answer "what do you have, what does it cost, do you deliver here", and
 * keep a person on the part that puts food on a stove.
 *
 * The menu count is shown alongside because the setting alone does not
 * decide this. With no menu there is nothing to quote from and the agent
 * is given no ordering tools whatever this says - so the screen says so,
 * rather than letting somebody set it to FULL and wonder why nothing
 * happens.
 */
function OrderTakingSection({
  settings, menuCount, disabled, onSave,
}: {
  settings: FoodSettingsDto;
  menuCount: number | null;
  disabled: boolean;
  onSave: (patch: Partial<FoodSettingsDto>) => void | Promise<void>;
}) {
  const value = settings.aiOrderTaking;
  /* Held locally while it is being typed and committed on blur, the same
     way the payment notice above is: saving on every keystroke would be a
     request per character, and a paragraph of house rules is a lot of
     characters. */
  const [rules, setRules] = useState(settings.orderTakingInstructions ?? '');
  const [prep, setPrep] = useState(settings.typicalPrepMinutes?.toString() ?? '');
  const onChange = (aiOrderTaking: FoodSettingsDto['aiOrderTaking']) => void onSave({ aiOrderTaking });

  const OPTIONS = [
    {
      value: 'FULL' as const,
      icon: Bot,
      label: 'It takes the whole order',
      hint: 'Answers menu and price questions, takes the order, and sends the ticket to the kitchen. Everything it quotes comes from your live menu — it cannot invent a price or an item.',
    },
    {
      value: 'QUOTE_ONLY' as const,
      icon: HandPlatter,
      label: 'It answers, you place the order',
      hint: 'Answers what is on the menu, what it costs and whether you deliver there — then tells the customer someone will confirm. Nothing reaches the kitchen without a person.',
    },
    {
      value: 'OFF' as const,
      icon: UserRound,
      label: 'You take every order',
      hint: 'It never uses the menu at all. It still answers everything else it normally would.',
    },
  ];

  return (
    <section className="rounded-xl border border-border-subtle bg-surface-2/40 p-3">
      <h3 className="text-caption font-semibold text-fg">Who takes the order</h3>
      <p className="mb-2.5 mt-0.5 text-meta text-fg-muted">
        This is your own assistant — the one whose name and tone you set on the Agents page. This only decides how much of
        an order it is allowed to handle.
      </p>

      <div className="space-y-1.5">
        {OPTIONS.map((option) => {
          const Icon = option.icon;
          const active = value === option.value;
          return (
            <label
              key={option.value}
              className={`flex cursor-pointer items-start gap-2.5 rounded-lg border p-2.5 transition-colors ${
                active ? 'border-accent bg-accent/5' : 'border-border-subtle hover:bg-surface-2'
              }`}
            >
              <input
                type="radio"
                name="ai-order-taking"
                className="sr-only"
                checked={active}
                disabled={disabled}
                onChange={() => onChange(option.value)}
              />
              <Icon size={15} className={`mt-0.5 shrink-0 ${active ? 'text-accent' : 'text-fg-muted'}`} aria-hidden />
              <span className="min-w-0">
                <span className="block text-caption font-medium text-fg">{option.label}</span>
                <span className="mt-0.5 block text-meta text-fg-muted">{option.hint}</span>
              </span>
              {active && <Check size={14} className="ml-auto mt-0.5 shrink-0 text-accent" aria-hidden />}
            </label>
          );
        })}
      </div>

      {/* Said only when it is actually true, and only when it actually
          matters: an owner who has chosen OFF is not waiting for orders
          that are not coming. */}
      {menuCount === 0 && value !== 'OFF' && (
        <p className="mt-2.5 flex items-start gap-1.5 rounded-lg bg-warning/10 px-2.5 py-2 text-meta text-warning">
          <AlertTriangle size={12} className="mt-px shrink-0" aria-hidden />
          There is nothing on your menu yet, so it cannot quote or take anything. Add your dishes under Menu first.
        </p>
      )}

      {/* Hidden under OFF, because none of it is used then and a setting
          that does nothing is a setting somebody will fill in and then
          wonder about. */}
      {value !== 'OFF' && (
        <div className="mt-3 space-y-3 border-t border-border-subtle pt-3">
          <div>
            <label htmlFor="order-rules" className="block text-caption font-medium text-fg">
              Your house rules for taking orders
            </label>
            <p className="mb-1.5 text-meta text-fg-muted">
              Anything your menu cannot say. It follows this exactly and never contradicts it. How it SOUNDS — its name
              and tone — stays on the Agents page.
            </p>
            <textarea
              id="order-rules"
              value={rules}
              onChange={(event) => setRules(event.target.value)}
              onBlur={() => {
                const trimmed = rules.trim();
                if (trimmed !== (settings.orderTakingInstructions ?? '')) void onSave({ orderTakingInstructions: trimmed || null });
              }}
              rows={4}
              maxLength={2000}
              placeholder={RULES_HINT}
              disabled={disabled}
              className="w-full rounded-lg border border-border-subtle bg-surface-1 px-3 py-2 text-caption text-fg placeholder:text-fg-muted"
            />
          </div>

          <div>
            <label htmlFor="prep-minutes" className="block text-caption font-medium text-fg">
              How long an order usually takes
            </label>
            <p className="mb-1.5 text-meta text-fg-muted">
              Minutes, once it reaches the kitchen. It says &ldquo;about&rdquo;, never a guarantee. Leave this empty and it
              will offer to check rather than guess a time you have to live up to.
            </p>
            <input
              id="prep-minutes"
              type="number"
              min={1}
              max={480}
              value={prep}
              onChange={(event) => setPrep(event.target.value)}
              onBlur={() => {
                const trimmed = prep.trim();
                if (trimmed === '') {
                  if (settings.typicalPrepMinutes !== null) void onSave({ typicalPrepMinutes: null });
                  return;
                }
                const minutes = Number(trimmed);
                // Out of range is left alone rather than clamped: silently
                // turning a typed 900 into 480 stores a promise the owner
                // never made.
                if (!Number.isInteger(minutes) || minutes < 1 || minutes > 480) return;
                if (minutes !== settings.typicalPrepMinutes) void onSave({ typicalPrepMinutes: minutes });
              }}
              placeholder="25"
              disabled={disabled}
              className="w-28 rounded-lg border border-border-subtle bg-surface-1 px-3 py-2 text-caption text-fg placeholder:text-fg-muted"
            />
          </div>
        </div>
      )}
    </section>
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
