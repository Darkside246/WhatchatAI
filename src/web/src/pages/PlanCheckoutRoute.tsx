import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Check, Info, Loader2 } from 'lucide-react';
import { api, ApiError, type PlanCatalogueDto } from '../lib/api.js';

type UpgradeOffer = Awaited<ReturnType<typeof api.getPlanUpgradeOffer>>['offer'];

function formatPrice(cents: number, currency: string): string {
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency,
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
  }).format(cents / 100);
}

/**
 * The real checkout/upgrade-detail page every Plans tile now links to
 * (BillingRoute.tsx) - a full breakdown of exactly what's being bought
 * and exactly what it costs before any payment starts, per the explicit
 * product decision that every plan change goes through this page rather
 * than a bare "upgrade" button with no confirmation step.
 *
 * Pricing here mirrors the AI token/memory top-up checkouts exactly
 * (BiMPay memo / PayPal approval link) - there is no automated recurring-
 * billing API in this app, so "prorated" means the amount calculated and
 * shown here as what's due today, never an automatic charge/refund
 * against a stored payment method.
 */
export function PlanCheckoutRoute() {
  const { planKey } = useParams<{ planKey: string }>();
  const navigate = useNavigate();
  const [offer, setOffer] = useState<UpgradeOffer | null | undefined>(undefined);
  const [catalogue, setCatalogue] = useState<PlanCatalogueDto | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [instructions, setInstructions] = useState<Record<string, unknown> | null>(null);

  useEffect(() => {
    if (!planKey) return;
    api
      .getPlanUpgradeOffer(planKey)
      .then((res) => setOffer(res.offer))
      .catch((err) => {
        setOffer(null);
        setLoadError(err instanceof ApiError ? err.message : 'Could not load this plan.');
      });
    api.getPlanCatalogue().then(setCatalogue).catch(() => undefined);
  }, [planKey]);

  async function handleConfirm() {
    if (!planKey) return;
    setBusy(true);
    setCheckoutError(null);
    try {
      const result = await api.createPlanUpgradeCheckout(planKey);
      setInstructions(result.instructions);
    } catch (err) {
      setCheckoutError(err instanceof ApiError ? err.message : 'Could not start checkout.');
    } finally {
      setBusy(false);
    }
  }

  if (offer === undefined) {
    return (
      <div className="flex-1 overflow-y-auto p-6">
        <p className="text-body text-fg-muted">Loading…</p>
      </div>
    );
  }

  if (offer === null) {
    return (
      <div className="flex-1 overflow-y-auto p-6">
        <button type="button" onClick={() => navigate('/billing')} className="flex items-center gap-1.5 text-caption font-medium text-fg-secondary hover:text-fg">
          <ArrowLeft size={14} aria-hidden />
          Back to Billing
        </button>
        <p className="mt-4 text-body text-error">{loadError ?? 'This plan is not available to upgrade to.'}</p>
      </div>
    );
  }

  const targetEntitlements = catalogue?.plans.find((plan) => plan.planKey === offer.targetPlan.planKey)?.entitlements ?? [];
  const approvalUrl = typeof instructions?.approvalUrl === 'string' ? instructions.approvalUrl : null;
  const memoInstruction = typeof instructions?.memoInstruction === 'string' ? instructions.memoInstruction : null;

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-2xl px-6 py-6">
        <button type="button" onClick={() => navigate('/billing')} className="flex items-center gap-1.5 text-caption font-medium text-fg-secondary hover:text-fg">
          <ArrowLeft size={14} aria-hidden />
          Back to Billing
        </button>

        <header className="mt-4">
          <h1 className="text-title font-semibold tracking-tight text-fg">Upgrade to {offer.targetPlan.name}</h1>
          <p className="mt-1 text-body text-fg-muted">
            Moving from {offer.currentPlan.name} ({formatPrice(offer.currentPlan.priceMonthlyCents, offer.currency)}/month) to {offer.targetPlan.name} ({formatPrice(offer.targetPlan.priceMonthlyCents, offer.currency)}/month).
          </p>
        </header>

        {/* ── Price breakdown ── */}
        <section className="mt-6 overflow-hidden rounded-2xl border border-border-subtle bg-surface-1 shadow-sm">
          <div className="space-y-2 border-b border-border-subtle p-5">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-body text-fg-secondary">{offer.targetPlan.name} plan price</span>
              <span className="tabular-nums text-body text-fg">{formatPrice(offer.fullAmountCents, offer.currency)}</span>
            </div>
            {offer.wasProrated && (
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-body text-fg-secondary">Credit for your current {offer.currentPlan.name} plan</span>
                <span className="tabular-nums text-body text-success">−{formatPrice(offer.currentPlan.priceMonthlyCents, offer.currency)}</span>
              </div>
            )}
            <div className="flex items-baseline justify-between gap-3 border-t border-border-subtle pt-2">
              <span className="text-body font-semibold text-fg">Due today</span>
              <span className="tabular-nums text-title font-semibold text-fg">{formatPrice(offer.amountDueCents, offer.currency)}</span>
            </div>
          </div>
          <div className="flex items-start gap-2 bg-surface-2 px-5 py-3">
            <Info size={14} className="mt-0.5 shrink-0 text-fg-muted" aria-hidden />
            <p className="text-caption text-fg-secondary">
              {offer.wasProrated
                ? `You're upgrading within 5 days of your current billing period, so the ${formatPrice(offer.currentPlan.priceMonthlyCents, offer.currency)} you already paid for ${offer.currentPlan.name} is credited toward this upgrade.`
                : `More than 5 days have passed since your current billing period started, so this upgrade is charged at ${offer.targetPlan.name}'s full price - there's no credit for the unused days remaining on your current plan.`}
            </p>
          </div>
        </section>

        {/* ── What you're getting ── */}
        <section className="mt-6">
          <h2 className="text-body font-semibold text-fg">What you're getting with {offer.targetPlan.name}</h2>
          <ul className="mt-3 space-y-2 rounded-2xl border border-border-subtle bg-surface-2 p-5">
            {targetEntitlements.map((entitlement) => (
              <li key={entitlement.key} className="flex items-baseline justify-between gap-3">
                <span className="flex min-w-0 items-baseline gap-1.5 text-caption text-fg-secondary">
                  <Check size={12} className="shrink-0 translate-y-0.5 text-success" aria-hidden />
                  {entitlement.label}
                </span>
                <span className="shrink-0 tabular-nums text-caption font-medium text-fg">
                  {entitlement.isEnabled ? (entitlement.limit === null ? 'Unlimited' : entitlement.limit.toLocaleString()) : 'Not included'}
                </span>
              </li>
            ))}
          </ul>
        </section>

        {/* ── Policy ── */}
        <p className="mt-6 text-caption text-fg-muted">
          Cancellations are eligible for a refund only within 48 hours of payment. After 48 hours, no refunds are issued.
        </p>

        {/* ── Confirm / instructions ── */}
        {!instructions && (
          <button
            type="button"
            onClick={() => void handleConfirm()}
            disabled={busy}
            className="mt-4 flex items-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-body font-semibold text-white transition hover:opacity-90 disabled:opacity-50"
          >
            {busy && <Loader2 size={15} className="animate-spin" aria-hidden />}
            {busy ? 'Starting checkout…' : `Confirm & pay ${formatPrice(offer.amountDueCents, offer.currency)}`}
          </button>
        )}

        {checkoutError && <p className="mt-2 text-caption text-error">{checkoutError}</p>}

        {instructions && (
          <div className="mt-4 rounded-xl border border-border-subtle bg-surface-2 p-4">
            {approvalUrl ? (
              <a href={approvalUrl} target="_blank" rel="noreferrer" className="text-caption font-semibold text-accent underline">
                Continue to PayPal to complete payment →
              </a>
            ) : memoInstruction ? (
              <p className="text-caption text-fg-secondary">{memoInstruction}</p>
            ) : (
              <p className="text-caption text-fg-secondary">Checkout started - follow the payment provider's instructions to complete it.</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
