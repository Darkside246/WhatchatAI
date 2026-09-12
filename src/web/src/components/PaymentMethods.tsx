import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Check, Star, Wallet } from 'lucide-react';
import {
  api,
  ApiError,
  type FoodPaymentAliasKindDto,
  type FoodPaymentCapabilityDto,
  type FoodPaymentMethodDto,
  type FoodPaymentMethodKeyDto,
} from '../lib/api.js';

/**
 * How this business gets paid.
 *
 * The screen's job is to be honest about each rail rather than to make them
 * look alike. BiMPay lands in the owner's own app in real time and nothing
 * tells us about it, so the screen says so plainly instead of implying the
 * board will update itself — an operator who expects that will leave orders
 * sitting behind the kitchen gate waiting for something that is not coming.
 *
 * Every capability shown here comes from the server. A fact about a payment
 * rail that the browser decides for itself is a fact that drifts.
 */

const ALIAS_KIND_LABEL: Record<FoodPaymentAliasKindDto, string> = {
  MOBILE: 'Mobile number',
  EMAIL: 'Email address',
  NICKNAME: 'Nickname',
  NATIONAL_ID: 'National ID',
  ACCOUNT_NUMBER: 'Account number',
};

export function PaymentMethods() {
  const [methods, setMethods] = useState<FoodPaymentMethodDto[] | null>(null);
  const [available, setAvailable] = useState<FoodPaymentCapabilityDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api
      .listFoodPaymentMethods()
      .then((result) => {
        setMethods(result.methods);
        setAvailable(result.available);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load your payment methods.'));
  }, []);

  useEffect(() => { load(); }, [load]);

  const run = useCallback(async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save that.');
      // Reloaded rather than left showing a toggle that looks on and is off.
      load();
    } finally {
      setBusy(false);
    }
  }, [load]);

  if (error && methods === null) return <p className="text-caption text-error">{error}</p>;
  if (methods === null) return <p className="text-caption text-fg-muted">Loading…</p>;

  const saved = new Map(methods.map((entry) => [entry.method, entry]));

  return (
    <div className="space-y-3">
      <div>
        <p className="flex items-center gap-1.5 text-body font-semibold text-fg">
          <Wallet size={15} aria-hidden />
          How you get paid
        </p>
        <p className="text-meta text-fg-muted">
          Switch on what you accept. The one you star is what customers are asked for automatically when an order is taken.
        </p>
      </div>

      {error && <p className="rounded-lg bg-error/10 px-3 py-2 text-caption text-error">{error}</p>}

      <ul className="space-y-2">
        {available.map((capability) => (
          <MethodRow
            key={capability.key}
            capability={capability}
            saved={saved.get(capability.key) ?? null}
            busy={busy}
            onRun={run}
          />
        ))}
      </ul>
    </div>
  );
}

function MethodRow({
  capability, saved, busy, onRun,
}: {
  capability: FoodPaymentCapabilityDto;
  saved: FoodPaymentMethodDto | null;
  busy: boolean;
  onRun: (action: () => Promise<unknown>) => Promise<void>;
}) {
  const enabled = saved?.enabled ?? false;
  const [alias, setAlias] = useState(saved?.alias ?? '');
  const [aliasKind, setAliasKind] = useState<FoodPaymentAliasKindDto | ''>(saved?.aliasKind ?? '');
  const [dailyLimit, setDailyLimit] = useState(
    saved?.dailyReceiveLimitCents != null ? (saved.dailyReceiveLimitCents / 100).toFixed(2) : '',
  );

  // An alias is required before switching on, so the field is offered even
  // while the method is off - otherwise the only way to enable it is to
  // hit an error first.
  const needsAlias = capability.needsAlias;
  const aliasMissing = needsAlias && !alias.trim();

  return (
    <li className={`rounded-lg border p-2.5 ${enabled ? 'border-border-subtle bg-surface-1' : 'border-border-subtle'}`}>
      <div className="flex items-start gap-2.5">
        <input
          type="checkbox"
          checked={enabled}
          disabled={busy || (!enabled && aliasMissing)}
          onChange={(event) =>
            void onRun(() =>
              api.saveFoodPaymentMethod(capability.key, {
                enabled: event.target.checked,
                ...(needsAlias ? { alias: alias.trim() || null } : {}),
                ...(aliasKind ? { aliasKind } : {}),
              }),
            )
          }
          aria-label={`Accept ${capability.label}`}
          className="mt-0.5 h-4 w-4 shrink-0 accent-accent"
        />

        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-1.5 text-caption font-medium text-fg">
            {capability.label}
            {saved?.preferred && (
              <span className="inline-flex items-center gap-0.5 rounded bg-accent-soft px-1.5 py-0.5 text-meta font-semibold text-accent">
                <Star size={9} aria-hidden />
                Asked for first
              </span>
            )}
            {/* Stated because it is genuinely good news and nobody would
                guess it: on an instant rail the customer cannot pay, eat
                and then cancel. Worded as "no chargebacks" rather than
                "cannot be reversed" - a recall procedure does exist, it
                just needs your agreement. */}
            {capability.irrevocable && (
              <span className="rounded bg-success/15 px-1.5 py-0.5 text-meta font-medium text-success">No chargebacks</span>
            )}
          </p>
          <p className="mt-0.5 text-meta text-fg-muted">{capability.description}</p>

          {enabled && capability.confirmation === 'MANUAL' && (
            <p className="mt-1 flex items-start gap-1 text-meta text-fg-secondary">
              <AlertTriangle size={11} className="mt-0.5 shrink-0" aria-hidden />
              {capability.guidance}
            </p>
          )}

          {needsAlias && (
            <div className="mt-2 flex flex-wrap items-end gap-2">
              <label className="min-w-0 flex-1">
                <span className="block text-meta font-medium text-fg">{capability.aliasLabel}</span>
                <input
                  value={alias}
                  onChange={(event) => setAlias(event.target.value)}
                  onBlur={() => {
                    const value = alias.trim();
                    if (value !== (saved?.alias ?? '')) void onRun(() => api.saveFoodPaymentMethod(capability.key, { alias: value || null }));
                  }}
                  placeholder="What customers send it to"
                  className="w-full rounded-md border border-border-subtle bg-surface-0 px-2.5 py-1.5 text-caption text-fg placeholder:text-fg-muted"
                />
              </label>

              {capability.aliasKinds.length > 1 && (
                <label className="w-40">
                  {/* Which KIND it is, because "send it to 2460000000" leaves
                      a customer guessing — and on a rail with no reversals a
                      payment to the wrong kind of identifier is gone. */}
                  <span className="block text-meta font-medium text-fg">What kind</span>
                  <select
                    value={aliasKind}
                    disabled={busy}
                    onChange={(event) => {
                      const value = event.target.value as FoodPaymentAliasKindDto | '';
                      setAliasKind(value);
                      if (value) void onRun(() => api.saveFoodPaymentMethod(capability.key, { aliasKind: value }));
                    }}
                    className="w-full rounded-md border border-border-subtle bg-surface-0 px-2.5 py-1.5 text-caption text-fg"
                  >
                    <option value="">Not said</option>
                    {capability.aliasKinds.map((kind) => (
                      <option key={kind} value={kind}>{ALIAS_KIND_LABEL[kind]}</option>
                    ))}
                  </select>
                </label>
              )}
            </div>
          )}

          {aliasMissing && !enabled && (
            <p className="mt-1 text-meta text-fg-muted">
              Add {capability.aliasLabel ? capability.aliasLabel.charAt(0).toLowerCase() + capability.aliasLabel.slice(1) : 'an alias'} before switching this on.
            </p>
          )}

          {/* The limit that would otherwise stop a Friday night without
              warning. Offered with the published basic-wallet figure,
              because most owners will not know their own number and the
              real one is whatever their bank set. */}
          {enabled && capability.key === 'BIMPAY' && (
            <div className="mt-2">
              <label className="block">
                <span className="block text-meta font-medium text-fg">Most you can receive in a day</span>
                <span className="mb-1 block text-meta text-fg-muted">
                  A basic BiMPay wallet is capped at 750.00 a day — a busy Friday passes that. Leave empty if your bank
                  set no limit. We will warn you before an order takes you past it.
                </span>
                <input
                  value={dailyLimit}
                  inputMode="decimal"
                  placeholder="750.00"
                  onChange={(event) => setDailyLimit(event.target.value)}
                  onBlur={() => {
                    const trimmed = dailyLimit.trim();
                    const cents = trimmed ? Math.round(Number(trimmed.replace(/[^0-9.]/g, '')) * 100) : null;
                    if (trimmed && !Number.isFinite(cents)) return;
                    if (cents !== (saved?.dailyReceiveLimitCents ?? null)) {
                      void onRun(() => api.saveFoodPaymentMethod(capability.key, { dailyReceiveLimitCents: cents }));
                    }
                  }}
                  className="w-32 rounded-md border border-border-subtle bg-surface-0 px-2.5 py-1.5 text-caption text-fg placeholder:text-fg-muted"
                />
              </label>
            </div>
          )}

          {enabled && !saved?.preferred && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void onRun(() => api.setPreferredFoodPaymentMethod(capability.key))}
              className="mt-2 flex items-center gap-1 text-meta font-medium text-fg-muted hover:text-accent disabled:opacity-40"
            >
              <Star size={11} aria-hidden />
              Ask for this one first
            </button>
          )}

          {enabled && saved?.preferred && (
            <p className="mt-2 flex items-center gap-1 text-meta text-success">
              <Check size={11} aria-hidden />
              Customers are asked for this automatically when an order is taken.
            </p>
          )}
        </div>
      </div>
    </li>
  );
}
