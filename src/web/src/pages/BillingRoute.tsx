import { useEffect, useState } from 'react';
import { Check, Minus, Sparkles, Info, CreditCard } from 'lucide-react';
import {
  api,
  type WorkspaceBillingOverview,
  type PlanCatalogueDto,
  type PlanCatalogueEntryDto,
} from '../lib/api.js';

type SubscriptionStatus = NonNullable<WorkspaceBillingOverview['subscription']>['status'];

const STATUS_LABEL: Record<SubscriptionStatus, string> = {
  ACTIVE: 'Active',
  TRIALING: 'Trial',
  PAST_DUE: 'Past due',
  PAUSED: 'Paused',
  CANCELLED: 'Cancelled',
  EXPIRED: 'Expired',
};

const STATUS_STYLE: Record<string, string> = {
  ACTIVE: 'bg-success/15 text-success ring-success/30',
  TRIALING: 'bg-info/15 text-info ring-info/30',
  PAST_DUE: 'bg-warning/15 text-warning ring-warning/30',
  PAUSED: 'bg-fg-muted/15 text-fg-muted ring-fg-muted/30',
  CANCELLED: 'bg-error/15 text-error ring-error/30',
  EXPIRED: 'bg-error/15 text-error ring-error/30',
};

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatPrice(cents: number, currency: string): string {
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency,
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
  }).format(cents / 100);
}

/** Renders a real entitlement limit. null means genuinely unlimited on that plan, not "unknown". */
function limitText(limit: number | null, isEnabled: boolean): string {
  if (!isEnabled) return 'Not included';
  return limit === null ? 'Unlimited' : limit.toLocaleString();
}

/**
 * Usage against a real, enforced limit. The bar turns amber before the wall
 * rather than at it, because hitting an entitlement limit blocks a real
 * action (creating an agent, connecting an account) and the operator should
 * see it coming.
 */
function UsageMeter({ label, current, limit }: { label: string; current: number; limit: number | null }) {
  if (limit === null) {
    return (
      <div className="flex items-baseline justify-between gap-3">
        <span className="min-w-0-safe text-body text-fg">{label}</span>
        <span className="shrink-0 text-caption text-fg-muted">{current.toLocaleString()} used · unlimited</span>
      </div>
    );
  }

  const ratio = current / Math.max(limit, 1);
  const percent = Math.min(100, Math.round(ratio * 100));
  const tone = ratio >= 1 ? 'bg-error' : ratio >= 0.8 ? 'bg-warning' : 'bg-accent';

  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <span className="min-w-0-safe text-body text-fg">{label}</span>
        <span className="shrink-0 tabular-nums text-caption text-fg-secondary">
          <span className="font-semibold text-fg">{current.toLocaleString()}</span> / {limit.toLocaleString()}
        </span>
      </div>
      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-surface-3">
        <div className={`h-full rounded-full transition-[width] ${tone}`} style={{ width: `${percent}%` }} />
      </div>
      {ratio >= 1 && <p className="mt-1 text-meta text-error">At your plan limit.</p>}
      {ratio >= 0.8 && ratio < 1 && <p className="mt-1 text-meta text-warning">Approaching your plan limit.</p>}
    </div>
  );
}

function PlanCard({ plan }: { plan: PlanCatalogueEntryDto }) {
  return (
    <div
      className={`relative flex flex-col rounded-2xl border p-5 transition-shadow ${
        plan.isCurrent
          ? 'border-accent bg-surface-1 shadow-lg ring-1 ring-accent/20'
          : 'border-border-subtle bg-surface-2 hover:shadow-md'
      }`}
    >
      {plan.isCurrent && (
        <span className="control-sm absolute -top-3 left-5 bg-accent font-semibold text-white">
          <Sparkles size={12} aria-hidden />
          Current plan
        </span>
      )}

      <p className="text-body font-semibold text-fg">{plan.name}</p>
      <p className="mt-2 flex items-baseline gap-1">
        <span className="text-display font-semibold tracking-tight text-fg">
          {formatPrice(plan.priceMonthlyCents, plan.currency)}
        </span>
        <span className="text-caption text-fg-muted">/ month</span>
      </p>

      <ul className="mt-4 space-y-2 border-t border-border-subtle pt-4">
        {plan.entitlements.map((entitlement) => (
          <li key={entitlement.key} className="flex items-baseline justify-between gap-3">
            <span className="flex min-w-0-safe items-baseline gap-1.5 text-caption text-fg-secondary">
              {entitlement.isEnabled ? (
                <Check size={12} className="shrink-0 translate-y-0.5 text-success" aria-hidden />
              ) : (
                <Minus size={12} className="shrink-0 translate-y-0.5 text-fg-muted" aria-hidden />
              )}
              {entitlement.label}
            </span>
            <span
              className={`shrink-0 tabular-nums text-caption ${entitlement.isEnabled ? 'font-medium text-fg' : 'text-fg-muted'}`}
            >
              {limitText(entitlement.limit, entitlement.isEnabled)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function BillingRoute() {
  const [billing, setBilling] = useState<WorkspaceBillingOverview | null>(null);
  const [catalogue, setCatalogue] = useState<PlanCatalogueDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .getBilling()
      .then(setBilling)
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load billing information.'));
    api
      .getPlanCatalogue()
      .then(setCatalogue)
      .catch(() => undefined);
  }, []);

  const subscription = billing?.subscription;
  const plan = billing?.plan;
  const metered = billing?.entitlements.filter((entitlement) => entitlement.isEnabled && entitlement.current !== null) ?? [];

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-5xl px-6 py-6">
        <header>
          <h1 className="text-title font-semibold tracking-tight text-fg">Billing</h1>
          <p className="mt-1 text-body text-fg-muted">
            Your real plan, subscription status, and usage against the limits this workspace actually enforces.
          </p>
        </header>

        {error && <p className="mt-4 text-caption text-error">{error}</p>}

        {billing && !subscription && (
          <div className="mt-6 rounded-2xl border border-dashed border-border-subtle p-10 text-center">
            <CreditCard size={22} className="mx-auto text-fg-muted" aria-hidden />
            <p className="mt-2 text-body text-fg-secondary">This workspace has no active subscription.</p>
          </div>
        )}

        {subscription && (
          <section className="mt-6 overflow-hidden rounded-2xl border border-border-subtle bg-surface-1 shadow-sm">
            {/* The one hero figure on this screen - the plan you are actually on. */}
            <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border-subtle bg-surface-2 p-6">
              <div className="min-w-0-safe">
                <p className="text-caption uppercase tracking-wide text-fg-muted">Current plan</p>
                <p className="mt-1 text-display font-semibold tracking-tight text-fg">{plan?.name ?? 'Unknown plan'}</p>
                {plan && (
                  <p className="mt-1 text-body text-fg-secondary">
                    {formatPrice(plan.priceMonthlyCents, plan.currency)} / month
                  </p>
                )}
              </div>
              <span
                className={`control-sm shrink-0 font-semibold ring-1 ${
                  STATUS_STYLE[subscription.status] ?? 'bg-surface-3 text-fg-secondary ring-border-subtle'
                }`}
              >
                {STATUS_LABEL[subscription.status] ?? subscription.status}
              </span>
            </div>

            <dl className="grid gap-x-6 gap-y-4 p-6 sm:grid-cols-3">
              <div>
                <dt className="text-caption text-fg-muted">Current period</dt>
                <dd className="mt-1 text-body text-fg">
                  {formatDate(subscription.currentPeriodStart)} – {formatDate(subscription.currentPeriodEnd)}
                </dd>
              </div>
              {subscription.status === 'TRIALING' && subscription.trialEndsAt && (
                <div>
                  <dt className="text-caption text-fg-muted">Trial ends</dt>
                  <dd className="mt-1 text-body text-fg">{formatDate(subscription.trialEndsAt)}</dd>
                </div>
              )}
              {subscription.cancelledAt && (
                <div>
                  <dt className="text-caption text-fg-muted">Cancelled</dt>
                  <dd className="mt-1 text-body text-fg">{formatDate(subscription.cancelledAt)}</dd>
                </div>
              )}
            </dl>
          </section>
        )}

        {metered.length > 0 && (
          <section className="mt-6">
            <h2 className="text-body font-semibold text-fg">Usage this period</h2>
            <p className="mt-1 text-caption text-fg-muted">
              Counted live from your real agents and connected accounts — not an estimate.
            </p>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              {metered.map((entitlement) => (
                <div key={entitlement.key} className="rounded-xl border border-border-subtle bg-surface-2 p-4">
                  <UsageMeter label={entitlement.label} current={entitlement.current ?? 0} limit={entitlement.limit} />
                </div>
              ))}
            </div>
          </section>
        )}

        {catalogue && catalogue.plans.length > 0 && (
          <section className="mt-8 pb-4">
            <h2 className="text-body font-semibold text-fg">Plans</h2>
            <p className="mt-1 text-caption text-fg-muted">
              Every limit shown here is the one the workspace genuinely enforces — the same values the entitlement checks
              read.
            </p>

            <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {catalogue.plans.map((entry) => (
                <PlanCard key={entry.planKey} plan={entry} />
              ))}
            </div>

            {/*
              No fake Upgrade button. There is no payment provider wired up,
              so a self-serve change genuinely cannot happen here and the
              screen says exactly that instead of offering a control that
              would do nothing.
            */}
            {!catalogue.selfServeChangeAvailable && (
              <p className="mt-4 flex items-start gap-2 rounded-xl border border-border-subtle bg-surface-2 px-4 py-3 text-caption text-fg-secondary">
                <Info size={14} className="mt-0.5 shrink-0 text-fg-muted" aria-hidden />
                {catalogue.selfServeUnavailableReason ?? 'Plan changes are handled manually.'}
              </p>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
