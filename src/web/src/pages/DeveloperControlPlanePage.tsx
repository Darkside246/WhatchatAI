import { useEffect, useState, type ComponentType } from 'react';
import type { LucideProps } from 'lucide-react';
import {
  Activity, Bot, CreditCard, Database, Gauge, KeyRound, Radio, ShieldCheck, Users,
  Building2, CookingPot, ShoppingBag, Scissors, Car, Stethoscope, Scale, Hotel,
  HardHat, Package, ChevronDown, ChevronRight, LayoutGrid, Check, HeartPulse, X, Coins,
  Wallet, Save,
} from 'lucide-react';
import { api, type DeveloperPlan, type PlanEntitlement } from '../lib/api.js';
import { ToggleSwitch } from '../components/ToggleSwitch.js';

// ── Types ──────────────────────────────────────────────────────────────────

type ControlSurface = { title: string; description: string; Icon: ComponentType<LucideProps>; to: string };
type Vertical = { id: string; product_key: string; name: string; description: string; is_active: boolean };
type ProductAccount = {
  id: string; businessId: string; productId: string; productKey: string;
  displayName: string; status: string; ownerUserId: string | null;
};

interface PlatformStats {
  totalBusinesses: number; activeWaConnections: number; totalAiAgents: number;
  activeTrials: number; recentSecurityEvents: number;
}

type SystemHealth = Awaited<ReturnType<typeof api.getSystemHealth>>;
type AiUsageOverview = Awaited<ReturnType<typeof api.getAiUsageOverview>>;

// ── Static data ────────────────────────────────────────────────────────────

const surfaces: ControlSurface[] = [
  { title: 'Clients',             description: 'Client identities, product accounts and provisioning',           Icon: Users,      to: '/crm' },
  { title: 'Product accounts',    description: 'Property and Food account boundaries and entitlements',          Icon: Database,   to: '/property' },
  { title: 'Trials',              description: '48-hour trial lifecycle and expiry monitoring',                  Icon: Activity,   to: '/billing' },
  { title: 'WhatsApp connections',description: 'Connection health, pairing state and operational scope',        Icon: Radio,      to: '/settings' },
  { title: 'AI agents',           description: 'Specialist agents, runtime state and human escalation',         Icon: Bot,        to: '/agents' },
  { title: 'AI providers',        description: 'Provider configuration, model routing and fallbacks',           Icon: Gauge,      to: '/agents' },
  { title: 'Billing',             description: 'Payment status, subscriptions and provider verification',       Icon: CreditCard, to: '/billing' },
  { title: 'Security & audit',    description: 'Permissions, audit trails and operational policy boundaries',   Icon: ShieldCheck,to: '/settings' },
];

const VERTICAL_ICONS: Record<string, ComponentType<LucideProps>> = {
  property:     Building2,
  food:         CookingPot,
  retail:       ShoppingBag,
  beauty:       Scissors,
  auto:         Car,
  health:       Stethoscope,
  legal:        Scale,
  hospitality:  Hotel,
  construction: HardHat,
  logistics:    Package,
};

const VERTICAL_COLOURS: Record<string, string> = {
  property:     'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
  food:         'bg-orange-500/15 text-orange-600 dark:text-orange-400',
  retail:       'bg-blue-500/15 text-blue-600 dark:text-blue-400',
  beauty:       'bg-pink-500/15 text-pink-600 dark:text-pink-400',
  auto:         'bg-slate-500/15 text-slate-600 dark:text-slate-400',
  health:       'bg-cyan-500/15 text-cyan-600 dark:text-cyan-400',
  legal:        'bg-purple-500/15 text-purple-600 dark:text-purple-400',
  hospitality:  'bg-amber-500/15 text-amber-600 dark:text-amber-400',
  construction: 'bg-yellow-500/15 text-yellow-700 dark:text-yellow-400',
  logistics:    'bg-teal-500/15 text-teal-600 dark:text-teal-400',
};

/** Mirrors BILLING_ENTITLEMENT_LABELS (workspaceService.ts) - display-only, so kept as a plain local map rather than round-tripping through the API. */
const ENTITLEMENT_LABELS: Record<string, string> = {
  max_ai_agents: 'AI Agents',
  max_whatsapp_accounts: 'WhatsApp Accounts',
  max_users: 'Team Members',
  advanced_analytics: 'Advanced Analytics',
  max_active_campaigns: 'Active Campaigns',
  max_active_funnels: 'Active Funnels',
  max_knowledge_base_documents: 'Knowledge Base Documents',
  max_business_documents: 'Business Documents',
  max_ai_tokens_per_month: 'AI Tokens / Month',
};

// ── Sub-components ─────────────────────────────────────────────────────────

function StatPill({ label, value }: { label: string; value: number | null }) {
  return (
    <div className="rounded-xl bg-surface-2 p-4">
      <span className="block text-2xl font-semibold tabular-nums text-fg">{value === null ? '—' : value}</span>
      <span className="mt-1 block text-caption text-fg-secondary">{label}</span>
    </div>
  );
}

function VerticalCard({ vertical }: { vertical: Vertical }) {
  const Icon = VERTICAL_ICONS[vertical.product_key] ?? LayoutGrid;
  const colour = VERTICAL_COLOURS[vertical.product_key] ?? 'bg-surface-3 text-fg-secondary';
  return (
    <div className="flex items-start gap-3 rounded-xl border border-border-subtle bg-surface-1 p-4">
      <div className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${colour}`}>
        <Icon size={18} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-title font-semibold leading-tight">{vertical.name}</p>
        <p className="mt-1 text-caption leading-5 text-fg-secondary">{vertical.description}</p>
        <span className={`mt-2 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-meta font-medium ${vertical.is_active ? 'bg-success/15 text-success' : 'bg-warning/15 text-warning'}`}>
          {vertical.is_active ? <Check size={11} /> : null}
          {vertical.is_active ? 'Available' : 'Disabled'}
        </span>
      </div>
    </div>
  );
}

function HealthBadge({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-meta font-medium ${ok ? 'bg-success/15 text-success' : 'bg-error/15 text-error'}`}>
      {ok ? <Check size={11} /> : <X size={11} />}
      {label}
    </span>
  );
}

/**
 * Aggregates the real /api/health/* checks (added across this session for
 * database, redis, BullMQ queues, and Goose fallback) into one developer
 * view - previously each existed as a standalone probe with nothing in
 * this admin UI surfacing them.
 */
function SystemHealthSection({ health }: { health: SystemHealth | null }) {
  if (!health) return <p className="text-caption text-fg-muted">Loading…</p>;
  const unhealthyQueues = health.queues.queues.filter((q) => !q.healthy);
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <div className="rounded-xl bg-surface-2 p-4">
          <p className="text-caption font-medium text-fg-secondary">Database</p>
          <div className="mt-2"><HealthBadge ok={health.database.available} label={health.database.available ? 'Connected' : (health.database.error ?? 'Unavailable')} /></div>
        </div>
        <div className="rounded-xl bg-surface-2 p-4">
          <p className="text-caption font-medium text-fg-secondary">Redis</p>
          <div className="mt-2"><HealthBadge ok={health.redis.available} label={health.redis.available ? 'Connected' : (health.redis.error ?? 'Unavailable')} /></div>
        </div>
        <div className="rounded-xl bg-surface-2 p-4">
          <p className="text-caption font-medium text-fg-secondary">Background queues</p>
          <div className="mt-2"><HealthBadge ok={health.queues.healthy} label={health.queues.healthy ? 'Healthy' : `${unhealthyQueues.length} degraded`} /></div>
        </div>
        <div className="rounded-xl bg-surface-2 p-4">
          <p className="text-caption font-medium text-fg-secondary">Goose fallback</p>
          <div className="mt-2">
            <HealthBadge
              ok={!health.goose.configured || health.goose.reachable}
              label={!health.goose.configured ? 'Not configured' : health.goose.reachable ? 'Reachable' : 'Unreachable'}
            />
          </div>
        </div>
      </div>
      {unhealthyQueues.length > 0 && (
        <div className="rounded-xl border border-error/30 bg-error/5 p-4">
          <p className="text-caption font-medium text-fg">Queues with a real backlog</p>
          <div className="mt-2 space-y-1">
            {unhealthyQueues.map((q) => (
              <p key={q.name} className="text-meta text-fg-secondary">
                <span className="font-medium text-fg">{q.name}</span> — {q.waiting} waiting, {q.failed} failed
              </p>
            ))}
          </div>
        </div>
      )}
      {health.goose.configured && (health.goose.lastSuccessAt || health.goose.lastFailureAt) && (
        <p className="text-meta text-fg-muted">
          Goose: {health.goose.lastSuccessAt ? `last succeeded ${new Date(health.goose.lastSuccessAt).toLocaleString()}` : 'never succeeded this process'}
          {health.goose.consecutiveFailureCount > 0 ? ` — ${health.goose.consecutiveFailureCount} consecutive failures` : ''}
        </p>
      )}
    </div>
  );
}

/**
 * Real Gemini token counts (ai_usage_events, migration 954) - deliberately
 * no dollar figure, since this codebase has no verified current Gemini
 * pricing table to compute one honestly. Tokens are the real number;
 * a $ estimate can be layered on once real pricing is confirmed.
 */
function AiUsageSection({ usage }: { usage: AiUsageOverview | null }) {
  if (!usage) return <p className="text-caption text-fg-muted">Loading…</p>;
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-xl bg-surface-2 p-4">
          <span className="block text-2xl font-semibold tabular-nums text-fg">{usage.last24h.totalTokens.toLocaleString()}</span>
          <span className="mt-1 block text-caption text-fg-secondary">Tokens, last 24h ({usage.last24h.callCount.toLocaleString()} calls)</span>
        </div>
        <div className="rounded-xl bg-surface-2 p-4">
          <span className="block text-2xl font-semibold tabular-nums text-fg">{usage.last7d.totalTokens.toLocaleString()}</span>
          <span className="mt-1 block text-caption text-fg-secondary">Tokens, last 7 days ({usage.last7d.callCount.toLocaleString()} calls)</span>
        </div>
      </div>
      {usage.topBusinessesLast24h.length > 0 && (
        <div>
          <p className="mb-2 text-caption font-medium text-fg-secondary">Top businesses by usage (24h)</p>
          <div className="space-y-1.5">
            {usage.topBusinessesLast24h.map((b) => (
              <div key={b.businessId} className="flex items-center justify-between rounded-lg border border-border-subtle bg-surface-1 px-3 py-2 text-caption">
                <span className="truncate text-fg">{b.businessName}</span>
                <span className="shrink-0 tabular-nums text-fg-secondary">{b.totalTokens.toLocaleString()} tokens · {b.callCount} calls</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {usage.last24h.callCount === 0 && <p className="text-caption text-fg-muted">No AI usage recorded yet in this window.</p>}
    </div>
  );
}

function AccountRow({
  account, verticals, onAssign,
}: {
  account: ProductAccount;
  verticals: Vertical[];
  onAssign: (businessId: string, key: string) => void;
}) {
  const [busy, setBusy] = useState(false);

  const handleChange = async (key: string) => {
    if (!key || key === account.productKey) return;
    setBusy(true);
    try {
      await api.assignVertical(account.businessId, key);
      onAssign(account.businessId, key);
    } finally {
      setBusy(false);
    }
  };

  const Icon = VERTICAL_ICONS[account.productKey] ?? LayoutGrid;
  const colour = VERTICAL_COLOURS[account.productKey] ?? 'bg-surface-3 text-fg-secondary';

  return (
    <div className="flex items-center gap-3 rounded-xl border border-border-subtle bg-surface-1 p-4">
      <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${colour}`}>
        <Icon size={18} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-title font-semibold">{account.displayName}</p>
        <p className="text-caption text-fg-muted">{account.status}</p>
      </div>
      <select
        value={account.productKey ?? ''}
        onChange={(e) => void handleChange(e.target.value)}
        disabled={busy}
        className="rounded-lg border border-border-subtle bg-surface-2 px-3 py-1.5 text-caption text-fg focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50"
      >
        <option value="">— assign vertical —</option>
        {verticals.filter((v) => v.is_active).map((v) => (
          <option key={v.product_key} value={v.product_key}>{v.name}</option>
        ))}
      </select>
    </div>
  );
}

/**
 * One editable limit row - "unlimited" is a real, distinct state (empty
 * field, matching plan_entitlements.limit_value = NULL's own documented
 * meaning), not just "a very large number", so the input is deliberately
 * left blank rather than defaulting to 0 when limitValue is null.
 */
function EntitlementRow({
  entitlement, onSave,
}: {
  entitlement: PlanEntitlement;
  onSave: (key: string, input: { limitValue: number | null; isEnabled: boolean }) => Promise<void>;
}) {
  const [limitText, setLimitText] = useState(entitlement.limitValue === null ? '' : String(entitlement.limitValue));
  const [isEnabled, setIsEnabled] = useState(entitlement.isEnabled);
  const [busy, setBusy] = useState(false);
  const dirty = isEnabled !== entitlement.isEnabled || limitText !== (entitlement.limitValue === null ? '' : String(entitlement.limitValue));

  const handleSave = async () => {
    const trimmed = limitText.trim();
    const limitValue = trimmed === '' ? null : Number(trimmed);
    if (limitValue !== null && (!Number.isFinite(limitValue) || limitValue < 0)) return;
    setBusy(true);
    try {
      await onSave(entitlement.entitlementKey, { limitValue, isEnabled });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-3 rounded-lg border border-border-subtle bg-surface-2 px-3 py-2">
      <span className="min-w-0 flex-1 truncate text-caption font-medium text-fg">
        {ENTITLEMENT_LABELS[entitlement.entitlementKey] ?? entitlement.entitlementKey}
      </span>
      <label className="flex items-center gap-1.5 text-meta text-fg-secondary">
        <input type="checkbox" checked={isEnabled} onChange={(e) => setIsEnabled(e.target.checked)} disabled={busy} />
        Enabled
      </label>
      <input
        type="number"
        min={0}
        placeholder="Unlimited"
        value={limitText}
        onChange={(e) => setLimitText(e.target.value)}
        disabled={busy}
        className="w-28 rounded-md border border-border-subtle bg-surface-1 px-2 py-1 text-meta text-fg focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50"
      />
      <button
        type="button"
        onClick={() => void handleSave()}
        disabled={busy || !dirty}
        className="flex items-center gap-1 rounded-md bg-accent-soft px-2 py-1 text-meta font-medium text-accent transition hover:bg-accent/20 disabled:opacity-40"
      >
        <Save size={12} /> Save
      </button>
    </div>
  );
}

function PlanCard({
  plan, onUpdatePlan, onUpdateEntitlement,
}: {
  plan: DeveloperPlan;
  onUpdatePlan: (planId: string, input: { priceMonthlyCents?: number; priceYearlyCents?: number | null; isActive?: boolean }) => Promise<void>;
  onUpdateEntitlement: (planId: string, key: string, input: { limitValue: number | null; isEnabled: boolean }) => Promise<void>;
}) {
  const [monthly, setMonthly] = useState(String(plan.priceMonthlyCents / 100));
  const [yearly, setYearly] = useState(plan.priceYearlyCents === null ? '' : String(plan.priceYearlyCents / 100));
  const [isActive, setIsActive] = useState(plan.isActive);
  const [busy, setBusy] = useState(false);
  const priceDirty =
    monthly !== String(plan.priceMonthlyCents / 100) ||
    yearly !== (plan.priceYearlyCents === null ? '' : String(plan.priceYearlyCents / 100)) ||
    isActive !== plan.isActive;

  const handleSavePrice = async () => {
    const monthlyCents = Math.round(Number(monthly) * 100);
    if (!Number.isFinite(monthlyCents) || monthlyCents < 0) return;
    const yearlyTrimmed = yearly.trim();
    const yearlyCents = yearlyTrimmed === '' ? null : Math.round(Number(yearlyTrimmed) * 100);
    if (yearlyCents !== null && (!Number.isFinite(yearlyCents) || yearlyCents < 0)) return;
    setBusy(true);
    try {
      await onUpdatePlan(plan.id, { priceMonthlyCents: monthlyCents, priceYearlyCents: yearlyCents, isActive });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-xl border border-border-subtle bg-surface-1 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-title font-semibold">{plan.name}</p>
          <p className="text-caption text-fg-muted">{plan.planKey}</p>
        </div>
        <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-meta font-medium ${isActive ? 'bg-success/15 text-success' : 'bg-warning/15 text-warning'}`}>
          {isActive ? <Check size={11} /> : null}
          {isActive ? 'Active' : 'Retired'}
        </span>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2">
        <label className="text-meta text-fg-secondary">
          Monthly ({plan.currency})
          <input
            type="number" min={0} step="0.01" value={monthly} disabled={busy}
            onChange={(e) => setMonthly(e.target.value)}
            className="mt-1 w-full rounded-md border border-border-subtle bg-surface-2 px-2 py-1 text-caption text-fg focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50"
          />
        </label>
        <label className="text-meta text-fg-secondary">
          Yearly ({plan.currency})
          <input
            type="number" min={0} step="0.01" placeholder="—" value={yearly} disabled={busy}
            onChange={(e) => setYearly(e.target.value)}
            className="mt-1 w-full rounded-md border border-border-subtle bg-surface-2 px-2 py-1 text-caption text-fg focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50"
          />
        </label>
      </div>

      <div className="mt-3 flex items-center justify-between">
        <label className="flex items-center gap-1.5 text-meta text-fg-secondary">
          <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} disabled={busy} />
          Plan is active (visible for new signups)
        </label>
        <button
          type="button"
          onClick={() => void handleSavePrice()}
          disabled={busy || !priceDirty}
          className="flex items-center gap-1 rounded-md bg-accent-soft px-2 py-1 text-meta font-medium text-accent transition hover:bg-accent/20 disabled:opacity-40"
        >
          <Save size={12} /> Save pricing
        </button>
      </div>

      <div className="mt-4 space-y-1.5">
        <p className="text-meta font-medium text-fg-secondary">Entitlements</p>
        {plan.entitlements.map((entitlement) => (
          <EntitlementRow
            key={entitlement.entitlementKey}
            entitlement={entitlement}
            onSave={(key, input) => onUpdateEntitlement(plan.id, key, input)}
          />
        ))}
      </div>
    </div>
  );
}

const PAYMENT_PROVIDER_LABELS: Record<string, string> = { bimpay: 'BiMPay', paypal: 'PayPal', wipay: 'WiPay' };

/**
 * Section 73-74: one row per registered payment provider. "Configured"
 * (real credentials present) and "enabled" (this live switch) are
 * independent - a developer can have real PayPal credentials in place and
 * still keep it off until they're ready, or flip a working provider off
 * instantly (e.g. mid-incident) without touching env vars or redeploying.
 */
function PaymentProviderRow({
  provider, onToggle,
}: {
  provider: { kind: string; configured: boolean; enabled: boolean };
  onToggle: (kind: string, enabled: boolean) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);

  const handleToggle = async () => {
    setBusy(true);
    try {
      await onToggle(provider.kind, !provider.enabled);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-border-subtle bg-surface-1 p-4">
      <div>
        <p className="text-title font-semibold">{PAYMENT_PROVIDER_LABELS[provider.kind] ?? provider.kind}</p>
        <p className="text-caption text-fg-muted">
          {provider.configured ? 'Credentials configured' : 'Not configured yet - set its env vars first'}
        </p>
      </div>
      <ToggleSwitch
        checked={provider.enabled}
        onChange={() => void handleToggle()}
        disabled={busy || !provider.configured}
        label={`${provider.enabled ? 'Disable' : 'Enable'} ${PAYMENT_PROVIDER_LABELS[provider.kind] ?? provider.kind}`}
      />
    </div>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────

export function DeveloperControlPlanePage() {
  const [stats, setStats] = useState<PlatformStats | null>(null);
  const [health, setHealth] = useState<SystemHealth | null>(null);
  const [aiUsage, setAiUsage] = useState<AiUsageOverview | null>(null);
  const [verticals, setVerticals] = useState<Vertical[]>([]);
  const [accounts, setAccounts] = useState<ProductAccount[]>([]);
  const [plans, setPlans] = useState<DeveloperPlan[]>([]);
  const [paymentProviders, setPaymentProviders] = useState<{ kind: string; configured: boolean; enabled: boolean }[]>([]);
  const [autonomyKillSwitch, setAutonomyKillSwitch] = useState<boolean | null>(null);
  const [catalogOpen, setCatalogOpen] = useState(true);
  const [accountsOpen, setAccountsOpen] = useState(true);
  const [healthOpen, setHealthOpen] = useState(true);
  const [aiUsageOpen, setAiUsageOpen] = useState(true);
  const [plansOpen, setPlansOpen] = useState(true);
  const [paymentProvidersOpen, setPaymentProvidersOpen] = useState(true);

  useEffect(() => {
    api.getControlPlaneStats().then((r) => setStats(r.stats)).catch(() => undefined);
    api.getSystemHealth().then(setHealth).catch(() => undefined);
    api.getAiUsageOverview().then(setAiUsage).catch(() => undefined);
    api.listVerticals().then((r) => setVerticals(r.verticals)).catch(() => undefined);
    api.listAllProductAccountsDev().then((r) => setAccounts(r.accounts)).catch(() => undefined);
    api.listPlans().then((r) => setPlans(r.plans)).catch(() => undefined);
    api.listPaymentProviders().then((r) => setPaymentProviders(r.providers)).catch(() => undefined);
    api.getAutonomyKillSwitch().then((r) => setAutonomyKillSwitch(r.enabled)).catch(() => undefined);
  }, []);

  const handleTogglePaymentProvider = async (kind: string, enabled: boolean) => {
    await api.togglePaymentProvider(kind, enabled);
    setPaymentProviders((prev) => prev.map((p) => (p.kind === kind ? { ...p, enabled } : p)));
  };

  const handleToggleAutonomyKillSwitch = async () => {
    const next = !autonomyKillSwitch;
    await api.setAutonomyKillSwitch(next);
    setAutonomyKillSwitch(next);
  };

  const handleAssign = (businessId: string, productKey: string) => {
    setAccounts((prev) =>
      prev.map((a) => (a.businessId === businessId ? { ...a, productKey } : a)),
    );
  };

  const handleUpdatePlan = async (planId: string, input: { priceMonthlyCents?: number; priceYearlyCents?: number | null; isActive?: boolean }) => {
    const { plan } = await api.updatePlan(planId, input);
    setPlans((prev) => prev.map((p) => (p.id === planId ? { ...p, ...plan } : p)));
  };

  const handleUpdateEntitlement = async (planId: string, entitlementKey: string, input: { limitValue: number | null; isEnabled: boolean }) => {
    const { entitlement } = await api.upsertPlanEntitlement(planId, entitlementKey, input);
    setPlans((prev) =>
      prev.map((p) =>
        p.id !== planId
          ? p
          : { ...p, entitlements: p.entitlements.some((e) => e.entitlementKey === entitlementKey) ? p.entitlements.map((e) => (e.entitlementKey === entitlementKey ? entitlement : e)) : [...p.entitlements, entitlement] },
      ),
    );
  };

  return (
    <div className="min-h-0 flex-1 overflow-auto bg-surface-0 p-5 sm:p-8">
      <div className="mx-auto max-w-7xl space-y-6">

        {/* Header */}
        <section className="rounded-2xl border border-border-subtle bg-surface-1 p-6 sm:p-8">
          <div className="flex items-start gap-4">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent">
              <KeyRound size={22} />
            </div>
            <div>
              <p className="text-meta font-semibold tracking-widest text-accent">DEVELOPER CONTROL PLANE</p>
              <h1 className="mt-1 text-3xl font-semibold tracking-tight">Platform administration</h1>
              <p className="mt-3 max-w-3xl text-body leading-7 text-fg-secondary">
                Cross-platform visibility, vertical provisioning and account management. Client dashboards remain product-specific and do not expose provider or cross-client controls.
              </p>
            </div>
          </div>
        </section>

        {/* ── Autonomy Kill Switch (Section 41-42 Phase 1) - always visible, never buried in a collapsible group ── */}
        <section className={`rounded-2xl border p-5 ${autonomyKillSwitch ? 'border-error/50 bg-error/5' : 'border-border-subtle bg-surface-1'}`}>
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-start gap-3">
              <ShieldCheck size={20} className={`mt-0.5 shrink-0 ${autonomyKillSwitch ? 'text-error' : 'text-accent'}`} />
              <div>
                <p className="text-title font-semibold">Autonomy Kill Switch</p>
                <p className="mt-1 max-w-2xl text-caption text-fg-secondary">
                  {autonomyKillSwitch
                    ? 'Every business\'s autonomous sweep is stopped platform-wide right now. Reactive AI replies to real customer messages are unaffected.'
                    : 'Instantly stops the autonomous work-while-you-sleep sweep for every business, platform-wide - without touching any business\'s own emergency pause or any agent\'s reply autonomy.'}
                </p>
              </div>
            </div>
            <ToggleSwitch
              checked={autonomyKillSwitch === true}
              onChange={() => void handleToggleAutonomyKillSwitch()}
              disabled={autonomyKillSwitch === null}
              label={autonomyKillSwitch ? 'Re-enable the autonomous sweep' : 'Stop the autonomous sweep platform-wide'}
            />
          </div>
        </section>

        {/* Stats */}
        <section className="grid gap-3 sm:grid-cols-5">
          <StatPill label="Total clients"          value={stats?.totalBusinesses ?? null} />
          <StatPill label="Active connections"     value={stats?.activeWaConnections ?? null} />
          <StatPill label="AI agents"              value={stats?.totalAiAgents ?? null} />
          <StatPill label="Active trials"          value={stats?.activeTrials ?? null} />
          <StatPill label="Security events (24h)"  value={stats?.recentSecurityEvents ?? null} />
        </section>

        {/* ── System health — collapsible hamburger group ── */}
        <section className="rounded-2xl border border-border-subtle bg-surface-1 overflow-hidden">
          <button
            type="button"
            onClick={() => setHealthOpen((o) => !o)}
            className="flex w-full items-center gap-3 px-6 py-4 text-left hover:bg-surface-2 transition-colors"
          >
            <HeartPulse size={18} className="shrink-0 text-accent" />
            <span className="flex-1 text-title font-semibold">System Health</span>
            <span className="text-caption text-fg-muted">
              {health ? (health.database.available && health.redis.available && health.queues.healthy ? 'All systems healthy' : 'Needs attention') : 'Loading…'}
            </span>
            {healthOpen
              ? <ChevronDown size={16} className="shrink-0 text-fg-muted" />
              : <ChevronRight size={16} className="shrink-0 text-fg-muted" />}
          </button>
          {healthOpen && (
            <div className="border-t border-border-subtle px-6 pb-6 pt-4">
              <SystemHealthSection health={health} />
            </div>
          )}
        </section>

        {/* ── AI usage — collapsible hamburger group ── */}
        <section className="rounded-2xl border border-border-subtle bg-surface-1 overflow-hidden">
          <button
            type="button"
            onClick={() => setAiUsageOpen((o) => !o)}
            className="flex w-full items-center gap-3 px-6 py-4 text-left hover:bg-surface-2 transition-colors"
          >
            <Coins size={18} className="shrink-0 text-accent" />
            <span className="flex-1 text-title font-semibold">AI Usage</span>
            <span className="text-caption text-fg-muted">
              {aiUsage ? `${aiUsage.last24h.totalTokens.toLocaleString()} tokens (24h)` : 'Loading…'}
            </span>
            {aiUsageOpen
              ? <ChevronDown size={16} className="shrink-0 text-fg-muted" />
              : <ChevronRight size={16} className="shrink-0 text-fg-muted" />}
          </button>
          {aiUsageOpen && (
            <div className="border-t border-border-subtle px-6 pb-6 pt-4">
              <AiUsageSection usage={aiUsage} />
            </div>
          )}
        </section>

        {/* ── Plan management — collapsible hamburger group ── */}
        <section className="rounded-2xl border border-border-subtle bg-surface-1 overflow-hidden">
          <button
            type="button"
            onClick={() => setPlansOpen((o) => !o)}
            className="flex w-full items-center gap-3 px-6 py-4 text-left hover:bg-surface-2 transition-colors"
          >
            <Wallet size={18} className="shrink-0 text-accent" />
            <span className="flex-1 text-title font-semibold">Plan Management</span>
            <span className="text-caption text-fg-muted">{plans.length} plans</span>
            {plansOpen
              ? <ChevronDown size={16} className="shrink-0 text-fg-muted" />
              : <ChevronRight size={16} className="shrink-0 text-fg-muted" />}
          </button>
          {plansOpen && (
            <div className="border-t border-border-subtle px-6 pb-6 pt-4">
              <p className="mb-4 text-caption text-fg-secondary">
                Edit pricing and per-tier limits directly - changes apply to every business on that plan immediately. Leave a limit blank for unlimited.
              </p>
              {plans.length === 0 ? (
                <p className="text-caption text-fg-muted">Loading…</p>
              ) : (
                <div className="grid gap-4 lg:grid-cols-2">
                  {plans.map((plan) => (
                    <PlanCard key={plan.id} plan={plan} onUpdatePlan={handleUpdatePlan} onUpdateEntitlement={handleUpdateEntitlement} />
                  ))}
                </div>
              )}
            </div>
          )}
        </section>

        {/* ── Payment providers — collapsible hamburger group (Section 73-74) ── */}
        <section className="rounded-2xl border border-border-subtle bg-surface-1 overflow-hidden">
          <button
            type="button"
            onClick={() => setPaymentProvidersOpen((o) => !o)}
            className="flex w-full items-center gap-3 px-6 py-4 text-left hover:bg-surface-2 transition-colors"
          >
            <CreditCard size={18} className="shrink-0 text-accent" />
            <span className="flex-1 text-title font-semibold">Payment Providers</span>
            <span className="text-caption text-fg-muted">{paymentProviders.filter((p) => p.enabled && p.configured).length} live</span>
            {paymentProvidersOpen
              ? <ChevronDown size={16} className="shrink-0 text-fg-muted" />
              : <ChevronRight size={16} className="shrink-0 text-fg-muted" />}
          </button>
          {paymentProvidersOpen && (
            <div className="border-t border-border-subtle px-6 pb-6 pt-4">
              <p className="mb-4 text-caption text-fg-secondary">
                A provider only accepts real checkouts when it's both configured (real credentials in the environment) and switched on here - flipping this takes effect immediately, no redeploy needed.
              </p>
              {paymentProviders.length === 0 ? (
                <p className="text-caption text-fg-muted">Loading…</p>
              ) : (
                <div className="grid gap-3 sm:grid-cols-2">
                  {paymentProviders.map((provider) => (
                    <PaymentProviderRow key={provider.kind} provider={provider} onToggle={handleTogglePaymentProvider} />
                  ))}
                </div>
              )}
            </div>
          )}
        </section>

        {/* ── Vertical catalog — collapsible hamburger group ── */}
        <section className="rounded-2xl border border-border-subtle bg-surface-1 overflow-hidden">
          <button
            type="button"
            onClick={() => setCatalogOpen((o) => !o)}
            className="flex w-full items-center gap-3 px-6 py-4 text-left hover:bg-surface-2 transition-colors"
          >
            <LayoutGrid size={18} className="shrink-0 text-accent" />
            <span className="flex-1 text-title font-semibold">Vertical Catalog</span>
            <span className="text-caption text-fg-muted">{verticals.length} verticals</span>
            {catalogOpen
              ? <ChevronDown size={16} className="shrink-0 text-fg-muted" />
              : <ChevronRight size={16} className="shrink-0 text-fg-muted" />}
          </button>
          {catalogOpen && (
            <div className="border-t border-border-subtle px-6 pb-6 pt-4">
              <p className="mb-4 text-caption text-fg-secondary">
                Every vertical available in the platform. Assign one to a client account below — the customer will see only that vertical's navigation and features.
              </p>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {verticals.map((v) => <VerticalCard key={v.product_key} vertical={v} />)}
              </div>
            </div>
          )}
        </section>

        {/* ── Client account vertical assignment ── */}
        <section className="rounded-2xl border border-border-subtle bg-surface-1 overflow-hidden">
          <button
            type="button"
            onClick={() => setAccountsOpen((o) => !o)}
            className="flex w-full items-center gap-3 px-6 py-4 text-left hover:bg-surface-2 transition-colors"
          >
            <Users size={18} className="shrink-0 text-accent" />
            <span className="flex-1 text-title font-semibold">Client Accounts — Vertical Assignment</span>
            <span className="text-caption text-fg-muted">{accounts.length} accounts</span>
            {accountsOpen
              ? <ChevronDown size={16} className="shrink-0 text-fg-muted" />
              : <ChevronRight size={16} className="shrink-0 text-fg-muted" />}
          </button>
          {accountsOpen && (
            <div className="border-t border-border-subtle px-6 pb-6 pt-4">
              <p className="mb-4 text-caption text-fg-secondary">
                Each client account is limited to one vertical. Changing it rebuilds their entitlements immediately — the customer will see their new vertical on next page load.
              </p>
              {accounts.length === 0 ? (
                <p className="text-caption text-fg-muted">No product accounts provisioned yet.</p>
              ) : (
                <div className="grid gap-3 sm:grid-cols-2">
                  {accounts.map((a) => (
                    <AccountRow key={a.id} account={a} verticals={verticals} onAssign={handleAssign} />
                  ))}
                </div>
              )}
            </div>
          )}
        </section>

        {/* Control surfaces grid */}
        <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {surfaces.map(({ title, description, Icon, to }) => (
            <a
              key={title}
              href={to}
              className="rounded-xl border border-border-subtle bg-surface-1 p-5 transition hover:border-accent/50 hover:bg-surface-2"
            >
              <Icon size={21} className="text-accent" />
              <h2 className="mt-4 text-title font-semibold">{title}</h2>
              <p className="mt-2 text-caption leading-6 text-fg-secondary">{description}</p>
              <span className="mt-4 inline-block text-caption font-semibold text-accent">Open surface →</span>
            </a>
          ))}
        </section>

        {/* Platform boundary reminder */}
        <section className="rounded-2xl border border-border-subtle bg-surface-1 p-6">
          <h2 className="text-title font-semibold">Platform boundary check</h2>
          <div className="mt-4 grid gap-3 text-caption text-fg-secondary md:grid-cols-3">
            <div className="rounded-xl bg-surface-2 p-4">
              <strong className="block text-fg">Clients</strong>
              <span className="mt-1 block">Only their assigned vertical and account data.</span>
            </div>
            <div className="rounded-xl bg-surface-2 p-4">
              <strong className="block text-fg">Product accounts</strong>
              <span className="mt-1 block">Separate tenant, billing, connection and audit boundaries.</span>
            </div>
            <div className="rounded-xl bg-surface-2 p-4">
              <strong className="block text-fg">Developer</strong>
              <span className="mt-1 block">Cross-platform visibility, vertical assignment and provisioning authority.</span>
            </div>
          </div>
        </section>

      </div>
    </div>
  );
}
