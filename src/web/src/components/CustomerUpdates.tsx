import { useCallback, useEffect, useState } from 'react';
import { MessageCircle } from 'lucide-react';
import {
  api,
  ApiError,
  type FoodNotificationEventName,
  type FoodSettingsDto,
} from '../lib/api.js';

/**
 * What a customer is told as their order moves.
 *
 * The machinery for this shipped without a screen, which meant a business
 * got our wording and no way to change it. Three of these messages are
 * genuinely useful and one of them - "on the way" - is the message people
 * most want and most businesses never send, so it is worth being able to
 * write in your own words.
 *
 * The defaults and the usable tokens come from the server rather than
 * being repeated here: a default that changes on the server and not on
 * this screen is a screen that lies about what a customer will receive.
 */

const EVENT_LABEL: Record<FoodNotificationEventName, string> = {
  ORDER_RECEIVED: 'When you take the order',
  PAYMENT_CONFIRMED: 'When the payment arrives',
  IN_KITCHEN: 'When it goes to the kitchen',
  READY_FOR_PICKUP: 'When it is ready to collect',
  OUT_FOR_DELIVERY: 'When it goes out for delivery',
  COMPLETED: 'When it is finished',
};

const ORDER: FoodNotificationEventName[] = [
  'ORDER_RECEIVED',
  'PAYMENT_CONFIRMED',
  'IN_KITCHEN',
  'READY_FOR_PICKUP',
  'OUT_FOR_DELIVERY',
  'COMPLETED',
];

const VERBOSITY: { value: FoodSettingsDto['notificationVerbosity']; label: string; hint: string }[] = [
  { value: 'MINIMAL', label: 'Only the essentials', hint: 'We have your order, and come and get it.' },
  { value: 'STANDARD', label: 'The usual', hint: 'Adds the payment and the kitchen — answers "has anything happened?"' },
  { value: 'DETAILED', label: 'Everything', hint: 'Adds the closing confirmation.' },
  { value: 'CUSTOM', label: 'My own', hint: 'You choose each message and write your own wording.' },
];

export function CustomerUpdates() {
  const [settings, setSettings] = useState<FoodSettingsDto | null>(null);
  const [defaults, setDefaults] = useState<Record<FoodNotificationEventName, string> | null>(null);
  const [tokens, setTokens] = useState<{ token: string; description: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    api
      .getFoodSettings()
      .then((result) => {
        setSettings(result.settings);
        setDefaults(result.notificationDefaults);
        setTokens(result.mergeFields);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load the customer updates.'));
  }, []);

  useEffect(() => { load(); }, [load]);

  async function save(patch: Partial<FoodSettingsDto>) {
    setSaving(true);
    setError(null);
    try {
      const { settings: updated } = await api.saveFoodSettings(patch);
      setSettings(updated);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save that.');
      // Reloaded rather than left showing something that was never stored.
      load();
    } finally {
      setSaving(false);
    }
  }

  if (error && !settings) return <p className="text-caption text-error">{error}</p>;
  if (!settings || !defaults) return <p className="text-caption text-fg-muted">Loading…</p>;

  const overrides = settings.notificationOverrides ?? {};

  function saveOverride(event: FoodNotificationEventName, change: { enabled?: boolean; template?: string }) {
    const next = { ...overrides, [event]: { ...overrides[event], ...change } };
    void save({ notificationOverrides: next });
  }

  return (
    <div className="space-y-3">
      <p className="flex items-center gap-1.5 text-body font-semibold text-fg">
        <MessageCircle size={15} aria-hidden />
        What customers are told
      </p>

      {error && <p className="rounded-lg bg-error/10 px-3 py-2 text-caption text-error">{error}</p>}

      <div className="space-y-1.5">
        {VERBOSITY.map((option) => (
          <label key={option.value} className="flex cursor-pointer items-start gap-2.5">
            <input
              type="radio"
              name="verbosity"
              checked={settings.notificationVerbosity === option.value}
              disabled={saving}
              onChange={() => void save({ notificationVerbosity: option.value })}
              className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-accent"
            />
            <span className="min-w-0">
              <span className="block text-caption font-medium text-fg">{option.label}</span>
              <span className="block text-meta text-fg-muted">{option.hint}</span>
            </span>
          </label>
        ))}
      </div>

      {settings.notificationVerbosity === 'CUSTOM' && (
        <div className="space-y-2.5 border-t border-border-subtle pt-3">
          <p className="text-meta text-fg-muted">
            Leave a message empty to use our wording. You can use{' '}
            {tokens.map((field, index) => (
              <span key={field.token}>
                <code className="text-fg-secondary" title={field.description}>{field.token}</code>
                {index < tokens.length - 1 ? ', ' : ''}
              </span>
            ))}
            .
          </p>

          {ORDER.map((event) => {
            const override = overrides[event] ?? {};
            const enabled = override.enabled !== false;
            return (
              <div key={event}>
                <label className="flex cursor-pointer items-center gap-2">
                  <input
                    type="checkbox"
                    checked={enabled}
                    disabled={saving}
                    onChange={(changed) => saveOverride(event, { enabled: changed.target.checked })}
                    className="h-3.5 w-3.5 accent-accent"
                  />
                  <span className="text-caption font-medium text-fg">{EVENT_LABEL[event]}</span>
                </label>
                {enabled && (
                  <TemplateBox
                    value={override.template ?? ''}
                    placeholder={defaults[event]}
                    disabled={saving}
                    onCommit={(template) => saveOverride(event, { template })}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Saved on blur, so every keystroke is not a write to the database. */
function TemplateBox({
  value, placeholder, disabled, onCommit,
}: {
  value: string;
  placeholder: string;
  disabled: boolean;
  onCommit: (template: string) => void;
}) {
  const [draft, setDraft] = useState(value);

  return (
    <textarea
      value={draft}
      rows={2}
      disabled={disabled}
      placeholder={placeholder}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => { if (draft.trim() !== value.trim()) onCommit(draft.trim()); }}
      className="mt-1 w-full rounded-md border border-border-subtle bg-surface-1 px-2.5 py-1.5 text-caption text-fg placeholder:text-fg-muted"
    />
  );
}
