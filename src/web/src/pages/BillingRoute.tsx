import { useEffect, useState } from 'react';
import { api, type WorkspaceBillingOverview } from '../lib/api.js';

type SubscriptionStatus = NonNullable<WorkspaceBillingOverview['subscription']>['status'];

const STATUS_LABEL: Record<SubscriptionStatus, string> = {
  ACTIVE: 'Active',
  TRIALING: 'Trial',
  PAST_DUE: 'Past due',
  PAUSED: 'Paused',
  CANCELLED: 'Cancelled',
  EXPIRED: 'Expired',
};

const STATUS_COLOR: Record<string, string> = {
  ACTIVE: 'bg-success/15 text-success',
  TRIALING: 'bg-info/15 text-info',
  PAST_DUE: 'bg-warning/15 text-warning',
  PAUSED: 'bg-fg-muted/15 text-fg-muted',
  CANCELLED: 'bg-error/15 text-error',
  EXPIRED: 'bg-error/15 text-error',
};

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatPrice(cents: number, currency: string): string {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(cents / 100);
}

function UsageBar({ current, limit }: { current: number; limit: number | null }) {
  if (limit === null) {
    return <p className="text-caption text-fg-muted">{current} used · unlimited</p>;
  }
  const percent = Math.min(100, Math.round((current / Math.max(limit, 1)) * 100));
  const atLimit = current >= limit;
  return (
    <div>
      <div className="flex items-center justify-between text-caption text-fg-secondary">
        <span>
          {current} / {limit}
        </span>
        {atLimit && <span className="text-warning">At limit</span>}
      </div>
      <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-surface-3">
        <div
          className={`h-full rounded-full ${atLimit ? 'bg-warning' : 'bg-accent'}`}
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}

export function BillingRoute() {
  const [billing, setBilling] = useState<WorkspaceBillingOverview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .getBilling()
      .then(setBilling)
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load billing information.'));
  }, []);

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <h1 className="text-title font-semibold text-fg">Billing</h1>
      <p className="mt-1 text-body text-fg-muted">Your real plan, subscription status, and usage against its limits.</p>

      {error && <p className="mt-4 text-caption text-error">{error}</p>}

      {billing && !billing.subscription && (
        <p className="mt-6 text-body text-fg-muted">This business has no active subscription.</p>
      )}

      {billing?.subscription && (
        <div className="mt-6 max-w-2xl space-y-6">
          <div className="rounded-xl border border-border-subtle bg-surface-2 p-5">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-body-lg font-semibold text-fg">{billing.plan?.name ?? 'Unknown plan'}</p>
                {billing.plan && (
                  <p className="mt-0.5 text-body text-fg-muted">
                    {formatPrice(billing.plan.priceMonthlyCents, billing.plan.currency)} / month
                  </p>
                )}
              </div>
              <span
                className={`rounded-full px-2.5 py-1 text-caption font-medium ${STATUS_COLOR[billing.subscription.status] ?? 'bg-surface-3 text-fg-secondary'}`}
              >
                {STATUS_LABEL[billing.subscription.status] ?? billing.subscription.status}
              </span>
            </div>

            <dl className="mt-4 grid grid-cols-2 gap-3 text-caption">
              {billing.subscription.status === 'TRIALING' && billing.subscription.trialEndsAt && (
                <div>
                  <dt className="text-fg-muted">Trial ends</dt>
                  <dd className="mt-0.5 text-fg-secondary">{formatDate(billing.subscription.trialEndsAt)}</dd>
                </div>
              )}
              <div>
                <dt className="text-fg-muted">Current period</dt>
                <dd className="mt-0.5 text-fg-secondary">
                  {formatDate(billing.subscription.currentPeriodStart)} – {formatDate(billing.subscription.currentPeriodEnd)}
                </dd>
              </div>
              {billing.subscription.cancelledAt && (
                <div>
                  <dt className="text-fg-muted">Cancelled</dt>
                  <dd className="mt-0.5 text-fg-secondary">{formatDate(billing.subscription.cancelledAt)}</dd>
                </div>
              )}
            </dl>
          </div>

          <div>
            <h2 className="text-body font-semibold text-fg">Usage</h2>
            <div className="mt-3 space-y-4">
              {billing.entitlements.map((entitlement) => (
                <div key={entitlement.key} className="rounded-lg border border-border-subtle bg-surface-2 p-3">
                  <div className="flex items-center justify-between">
                    <p className="text-body text-fg">{entitlement.label}</p>
                    {!entitlement.isEnabled && (
                      <span className="rounded-full bg-fg-muted/15 px-2 py-0.5 text-meta text-fg-muted">Not on this plan</span>
                    )}
                  </div>
                  {entitlement.isEnabled && entitlement.current !== null && (
                    <div className="mt-2">
                      <UsageBar current={entitlement.current} limit={entitlement.limit} />
                    </div>
                  )}
                  {entitlement.isEnabled && entitlement.current === null && entitlement.limit !== null && (
                    <p className="mt-2 text-caption text-fg-muted">Limit: {entitlement.limit}</p>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
