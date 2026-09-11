import { useEffect, useState, type ComponentType } from 'react';
import type { LucideProps } from 'lucide-react';
import {
  Activity, Bot, CreditCard, Database, Gauge, KeyRound, Radio, ShieldCheck, Users,
  Building2, CookingPot, ShoppingBag, Scissors, Car, Stethoscope, Scale, Hotel,
  HardHat, Package, ChevronDown, ChevronRight, LayoutGrid, Check, HeartPulse, X, Coins,
  Wallet, Save, PlugZap, Plus, ShieldAlert, Radar,
} from 'lucide-react';
import { api, ApiError, type DeveloperPlan, type PlanEntitlement, type IntegrationHealth, type GovernanceFlagDto, type GovernanceThresholdsDto, type OversightFindingDto, type OversightThresholdsDto } from '../lib/api.js';
import { ToggleSwitch } from '../components/ToggleSwitch.js';
import { IntegrationHealthList } from '../components/IntegrationHealthList.js';
import { useAuth } from '../hooks/useAuth.js';

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
type PlatformConfig = Awaited<ReturnType<typeof api.getPlatformConfig>>;
type OpenClawStatus = Awaited<ReturnType<typeof api.getOpenClawStatus>>;
type DeveloperAccount = Awaited<ReturnType<typeof api.getDeveloperAccounts>>['accounts'][number];

// ── Static data ────────────────────────────────────────────────────────────

/**
 * "AI providers" and "Billing" used to link out to other pages - both are
 * now embedded directly on this page (AI Providers, OpenClaw, and Plan
 * Management sections below), per the Developer Master Control page
 * directive: one page, not a hub of links, for platform-wide config.
 * "Clients" and "Trials" previously linked to the developer's own
 * business's CRM/Billing pages too - nonsensical for a platform operator
 * who needs every account, not just their own - now replaced by the real
 * cross-tenant Accounts section below.
 */
const surfaces: ControlSurface[] = [
  { title: 'Product accounts',    description: 'Property and Food account boundaries and entitlements',          Icon: Database,   to: '/property' },
  { title: 'WhatsApp connections',description: 'Connection health, pairing state and operational scope',        Icon: Radio,      to: '/settings' },
  { title: 'AI agents',           description: 'Specialist agents, runtime state and human escalation',         Icon: Bot,        to: '/agents' },
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
  max_customer_memory_profiles: 'Customer Memory Profiles',
};

// ── Sub-components ─────────────────────────────────────────────────────────

function StatPill({ label, value, to }: { label: string; value: number | null; to?: string }) {
  const content = (
    <>
      <span className="block text-2xl font-semibold tabular-nums text-fg">{value === null ? '—' : value}</span>
      <span className="mt-1 block text-caption text-fg-secondary">{label}</span>
    </>
  );
  if (!to) return <div className="rounded-xl bg-surface-2 p-4">{content}</div>;
  return (
    <a href={to} className="block rounded-xl bg-surface-2 p-4 transition hover:bg-surface-3">
      {content}
    </a>
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
        <AddEntitlementRow
          existingKeys={plan.entitlements.map((e) => e.entitlementKey)}
          onAdd={(key) => onUpdateEntitlement(plan.id, key, { limitValue: null, isEnabled: true })}
        />
      </div>
    </div>
  );
}

/** The existing PUT .../entitlements/:key route already upserts (no backend change needed) - this is just the missing frontend affordance to introduce a brand-new entitlement key onto a plan that doesn't have it yet. */
function AddEntitlementRow({ existingKeys, onAdd }: { existingKeys: string[]; onAdd: (key: string) => Promise<void> }) {
  const [adding, setAdding] = useState(false);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const available = Object.keys(ENTITLEMENT_LABELS).filter((k) => !existingKeys.includes(k));

  async function handleAdd() {
    if (!key) return;
    setBusy(true);
    try { await onAdd(key); setKey(''); setAdding(false); } finally { setBusy(false); }
  }

  if (available.length === 0) return null;
  if (!adding) {
    return (
      <button type="button" onClick={() => setAdding(true)} className="flex items-center gap-1 text-meta font-medium text-accent hover:underline">
        <Plus size={11} aria-hidden /> Add entitlement
      </button>
    );
  }
  return (
    <div className="flex items-center gap-2">
      <select value={key} onChange={(e) => setKey(e.target.value)} disabled={busy} className="rounded-md border border-border-subtle bg-surface-2 px-2 py-1 text-meta text-fg focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50">
        <option value="">— choose —</option>
        {available.map((k) => <option key={k} value={k}>{ENTITLEMENT_LABELS[k]}</option>)}
      </select>
      <button type="button" onClick={() => void handleAdd()} disabled={busy || !key} className="rounded-md bg-accent-soft px-2 py-1 text-meta font-medium text-accent hover:bg-accent/20 disabled:opacity-40">Add</button>
      <button type="button" onClick={() => setAdding(false)} className="text-meta text-fg-secondary hover:text-fg">Cancel</button>
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

const SUBSCRIPTION_STATUS_STYLE: Record<string, string> = {
  ACTIVE: 'bg-success/15 text-success',
  TRIALING: 'bg-info/15 text-info',
  PAST_DUE: 'bg-warning/15 text-warning',
  PAUSED: 'bg-surface-3 text-fg-muted',
  CANCELLED: 'bg-surface-3 text-fg-muted',
  EXPIRED: 'bg-error/15 text-error',
};

/** One row in the Accounts table - phone number as the real identifier, a real trial/plan status, and the manual "change plan" override this feature exists for. */
function PlatformAccountRow({
  account, plans, busy, onChangePlan,
}: {
  account: DeveloperAccount;
  plans: DeveloperPlan[];
  busy: boolean;
  onChangePlan: (businessId: string, planKey: string) => Promise<void>;
}) {
  const [selectedPlanKey, setSelectedPlanKey] = useState(account.planKey ?? '');

  return (
    <tr className="border-b border-border-subtle last:border-0">
      <td className="py-2 pr-4 font-mono">
        {account.phoneNumber ?? <span className="text-fg-muted">No phone on file</span>}
        {account.isDeveloper && <span className="ml-1.5 rounded-full bg-accent-soft px-1.5 py-0.5 text-meta font-medium text-accent">you / developer</span>}
      </td>
      <td className="py-2 pr-4 text-fg-secondary">{new Date(account.signupDate).toLocaleDateString(undefined, { dateStyle: 'medium' })}</td>
      <td className="py-2 pr-4 text-fg-secondary">{account.businessName ?? '—'}</td>
      <td className="py-2 pr-4">
        {account.subscriptionStatus ? (
          <span className={`rounded-full px-2 py-0.5 text-meta font-medium ${SUBSCRIPTION_STATUS_STYLE[account.subscriptionStatus] ?? 'bg-surface-3 text-fg-muted'}`}>
            {account.subscriptionStatus}
            {account.subscriptionStatus === 'TRIALING' && account.trialEndsAt && ` · ends ${new Date(account.trialEndsAt).toLocaleDateString(undefined, { dateStyle: 'medium' })}`}
          </span>
        ) : (
          <span className="text-fg-muted">No subscription</span>
        )}
      </td>
      <td className="py-2 pr-4 text-fg-secondary">{account.planName ?? '—'}</td>
      <td className="py-2">
        {account.businessId ? (
          <div className="flex items-center gap-1.5">
            <select
              value={selectedPlanKey}
              onChange={(e) => setSelectedPlanKey(e.target.value)}
              disabled={busy}
              className="rounded-lg border border-border-subtle bg-surface-2 px-2 py-1 text-caption text-fg disabled:opacity-50"
            >
              <option value="">Choose a plan…</option>
              {plans.map((plan) => (
                <option key={plan.id} value={plan.planKey}>{plan.name}</option>
              ))}
            </select>
            <button
              type="button"
              disabled={busy || !selectedPlanKey || selectedPlanKey === account.planKey}
              onClick={() => void onChangePlan(account.businessId!, selectedPlanKey)}
              className="rounded-lg border border-accent px-2 py-1 text-caption font-medium text-accent hover:bg-accent-soft disabled:opacity-50"
            >
              {busy ? 'Saving…' : 'Change plan'}
            </button>
          </div>
        ) : (
          <span className="text-fg-muted">No business</span>
        )}
      </td>
    </tr>
  );
}

/**
 * Developer Master Control Page: one always-visible row per global
 * kill-switch, same "never buried in a collapsible group" treatment the
 * pre-existing Autonomy Kill Switch already gets - these are the highest-
 * blast-radius toggles on the page.
 */
function KillSwitchRow({
  title, description, checked, onToggle, dangerWhenOn = true,
}: {
  title: string;
  description: string;
  checked: boolean | null;
  onToggle: () => Promise<void>;
  dangerWhenOn?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const handleToggle = async () => {
    setBusy(true);
    try { await onToggle(); } finally { setBusy(false); }
  };
  const on = checked === true;
  return (
    <div className={`rounded-xl border p-4 ${on && dangerWhenOn ? 'border-error/50 bg-error/5' : 'border-border-subtle bg-surface-1'}`}>
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-body font-semibold">{title}</p>
          <p className="mt-1 max-w-2xl text-caption text-fg-secondary">{description}</p>
        </div>
        <ToggleSwitch checked={on} onChange={() => void handleToggle()} disabled={busy || checked === null} label={title} />
      </div>
    </div>
  );
}

const TOPUP_CATALOG_PLAN_KEYS = ['starter', 'growth', 'business'] as const;

/** Live-editable AI token top-up pack/price per plan tier - what a business actually sees and pays on their Billing page (BillingRoute.tsx's AiTokenTopupOffer). Falls back to the hardcoded default catalog until a developer explicitly overrides it here (platformConfigService.ts's getAiTokenTopupCatalogOverride). */
function TokenTopupCatalogEditor({ catalog, onSaved }: { catalog: PlatformConfig['aiTokenTopupCatalog'] | undefined; onSaved: () => void }) {
  const [rows, setRows] = useState<PlatformConfig['aiTokenTopupCatalog']>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (catalog) setRows(catalog);
  }, [catalog]);

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      await api.setPlatformConfig('ai_token_topup_catalog', rows);
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to save.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-xl border border-border-subtle bg-surface-2 p-4">
      <p className="text-body font-semibold text-fg">AI Token Top-Up Catalog</p>
      <p className="mt-1 text-caption text-fg-muted">The real pack size and price a business sees on their Billing page, per plan tier.</p>
      <div className="mt-3 space-y-2">
        {TOPUP_CATALOG_PLAN_KEYS.map((planKey) => {
          const entry = rows[planKey];
          if (!entry) return null;
          return (
            <div key={planKey} className="flex flex-wrap items-center gap-2">
              <span className="w-20 shrink-0 text-caption font-medium capitalize text-fg-secondary">{planKey}</span>
              <input
                type="number"
                min={1}
                value={entry.tokens}
                onChange={(event) => setRows((r) => ({ ...r, [planKey]: { ...entry, tokens: Number(event.target.value) } }))}
                className="field w-28 border border-border-subtle bg-surface-1 text-fg"
              />
              <span className="text-caption text-fg-muted">tokens for $</span>
              <input
                type="number"
                min={0.01}
                step={0.01}
                value={(entry.priceCents / 100).toFixed(2)}
                onChange={(event) => setRows((r) => ({ ...r, [planKey]: { ...entry, priceCents: Math.round(Number(event.target.value) * 100) } }))}
                className="field w-20 border border-border-subtle bg-surface-1 text-fg"
              />
              <span className="text-caption text-fg-muted">{entry.currency}</span>
            </div>
          );
        })}
      </div>
      {error && <p className="mt-2 text-caption text-error">{error}</p>}
      <button
        type="button"
        onClick={() => void handleSave()}
        disabled={saving}
        className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-caption font-semibold text-white transition hover:opacity-90 disabled:opacity-50"
      >
        <Save size={13} aria-hidden />
        {saving ? 'Saving…' : 'Save catalog'}
      </button>
    </div>
  );
}

/** The AI-memory-capacity sibling of TokenTopupCatalogEditor above - same shape, drives BillingRoute.tsx's AiMemoryTopupOffer. A verified memory purchase is a permanent capacity add, never a monthly reset (unlike tokens), but the catalog itself edits identically. */
function MemoryTopupCatalogEditor({ catalog, onSaved }: { catalog: PlatformConfig['aiMemoryTopupCatalog'] | undefined; onSaved: () => void }) {
  const [rows, setRows] = useState<PlatformConfig['aiMemoryTopupCatalog']>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (catalog) setRows(catalog);
  }, [catalog]);

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      await api.setPlatformConfig('ai_memory_topup_catalog', rows);
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to save.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-xl border border-border-subtle bg-surface-2 p-4">
      <p className="text-body font-semibold text-fg">AI Memory Top-Up Catalog</p>
      <p className="mt-1 text-caption text-fg-muted">The real pack size and price a business sees on their Billing page, per plan tier. Added permanently, never resets.</p>
      <div className="mt-3 space-y-2">
        {TOPUP_CATALOG_PLAN_KEYS.map((planKey) => {
          const entry = rows[planKey];
          if (!entry) return null;
          return (
            <div key={planKey} className="flex flex-wrap items-center gap-2">
              <span className="w-20 shrink-0 text-caption font-medium capitalize text-fg-secondary">{planKey}</span>
              <input
                type="number"
                min={1}
                value={entry.profiles}
                onChange={(event) => setRows((r) => ({ ...r, [planKey]: { ...entry, profiles: Number(event.target.value) } }))}
                className="field w-28 border border-border-subtle bg-surface-1 text-fg"
              />
              <span className="text-caption text-fg-muted">memory slots for $</span>
              <input
                type="number"
                min={0.01}
                step={0.01}
                value={(entry.priceCents / 100).toFixed(2)}
                onChange={(event) => setRows((r) => ({ ...r, [planKey]: { ...entry, priceCents: Math.round(Number(event.target.value) * 100) } }))}
                className="field w-20 border border-border-subtle bg-surface-1 text-fg"
              />
              <span className="text-caption text-fg-muted">{entry.currency}</span>
            </div>
          );
        })}
      </div>
      {error && <p className="mt-2 text-caption text-error">{error}</p>}
      <button
        type="button"
        onClick={() => void handleSave()}
        disabled={saving}
        className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-caption font-semibold text-white transition hover:opacity-90 disabled:opacity-50"
      >
        <Save size={13} aria-hidden />
        {saving ? 'Saving…' : 'Save catalog'}
      </button>
    </div>
  );
}

/** Booleans only - no secret value, masked or otherwise, ever leaves the server. Editing a real secret still means updating the environment and restarting. */
/**
 * One AI provider's real, configured state in the gateway's own fallback
 * order.
 *
 * "Configured" is derived from whether that provider's API key is actually
 * present in the environment (the same secrets status the checklist below
 * reads) - never a hardcoded value. A provider with no key is never
 * registered at all, so "Not configured" genuinely means it can never
 * receive customer context.
 *
 * Deliberately has NO enable/disable control. Upstream this card carried a
 * ToggleSwitch that was permanently disabled with a no-op handler - a
 * switch that can never move is a dead control, and worse, it implies a
 * per-provider override that does not exist. Provider eligibility really is
 * decided by the gateway from capability and key presence, so this states
 * that plainly instead of pretending otherwise.
 */
function AiProviderCard({
  name,
  role,
  priority,
  secretName,
  secrets,
  capabilities,
}: {
  name: string;
  role: string;
  priority: number;
  secretName: string;
  secrets: { name: string; configured: boolean }[];
  capabilities: string[];
}) {
  const configured = secrets.some((secret) => secret.name === secretName && secret.configured);

  return (
    <div className="space-y-2.5 rounded-xl border border-border-subtle bg-surface-2 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-caption font-semibold text-fg">
            {name}
            {/* The real position in the gateway's fallback order, so the
                order is visible rather than something to infer. */}
            <span className="ml-1.5 font-normal text-meta text-fg-muted">#{priority}</span>
          </p>
          <p className="text-meta text-fg-muted">{role}</p>
        </div>
        <HealthBadge ok={configured} label={configured ? 'Configured' : 'Not configured'} />
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {capabilities.map((capability) => (
          <span key={capability} className="inline-flex items-center rounded-full bg-accent-soft px-2 py-0.5 text-meta font-medium text-accent">
            {capability}
          </span>
        ))}
      </div>

      <p className="text-meta leading-4 text-fg-secondary">
        {configured
          ? 'Eligible for automatic routing. The gateway picks it by capability and fallback order — there is no per-provider override.'
          : `Never registered while ${secretName} is unset, so it cannot receive customer context.`}
      </p>
    </div>
  );
}

function SecretsChecklist({ secrets }: { secrets: { name: string; configured: boolean }[] }) {
  if (secrets.length === 0) return null;
  return (
    <div className="grid gap-1.5 sm:grid-cols-2">
      {secrets.map((s) => (
        <div key={s.name} className="flex items-center justify-between gap-2 rounded-lg border border-border-subtle bg-surface-2 px-3 py-1.5">
          <span className="truncate text-meta text-fg-secondary">{s.name}</span>
          <HealthBadge ok={s.configured} label={s.configured ? 'Configured' : 'Not set'} />
        </div>
      ))}
    </div>
  );
}

/**
 * Gemini gets its own dedicated status card + a real "Test connection"
 * button, mirroring what Goose already had via SystemHealthSection - both
 * engines now get equal visibility. The model-override field is safe to
 * make live-editable (unlike an API key): it's just a model name, not a
 * secret.
 */
function GeminiProviderCard({ modelOverride, onSetModelOverride }: { modelOverride: string | null; onSetModelOverride: (model: string | null) => Promise<void> }) {
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ status: 'ok' | 'failed'; detail: string } | null>(null);
  const [modelInput, setModelInput] = useState(modelOverride ?? '');
  const [saving, setSaving] = useState(false);

  useEffect(() => setModelInput(modelOverride ?? ''), [modelOverride]);

  async function handleTest() {
    setTesting(true);
    setResult(null);
    try {
      const r = await api.testGeminiConnectionDeveloper();
      setResult(r.status === 'ok' ? { status: 'ok', detail: r.detail } : { status: 'failed', detail: r.reason });
    } catch (err) {
      setResult({ status: 'failed', detail: err instanceof ApiError ? err.message : 'Test failed.' });
    } finally {
      setTesting(false);
    }
  }

  async function handleSaveModel() {
    setSaving(true);
    try { await onSetModelOverride(modelInput.trim() || null); } finally { setSaving(false); }
  }

  return (
    <div className="space-y-3 rounded-xl border border-border-subtle bg-surface-1 p-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-title font-semibold">Gemini</p>
        <span className="text-meta text-fg-muted">primary</span>
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => void handleTest()}
          disabled={testing}
          className="flex items-center gap-1 rounded-md border border-border-subtle px-2 py-1 text-meta font-medium text-fg-secondary hover:border-accent hover:text-accent disabled:opacity-40"
        >
          <PlugZap size={11} aria-hidden />
          {testing ? 'Testing…' : 'Test connection'}
        </button>
        {result && (
          <span className={`text-meta ${result.status === 'ok' ? 'text-success' : 'text-error'}`}>
            {result.status === 'ok' ? '✓ ' : '✗ '}{result.detail}
          </span>
        )}
      </div>
      <div>
        <label className="text-meta font-medium text-fg-secondary">Model override (optional - blank uses the env-var chain)</label>
        <div className="mt-1 flex gap-2">
          <input
            value={modelInput}
            onChange={(e) => setModelInput(e.target.value)}
            placeholder="gemini-3.5-flash"
            disabled={saving}
            className="w-full rounded-md border border-border-subtle bg-surface-2 px-2 py-1.5 text-caption text-fg focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50"
          />
          <button
            type="button"
            onClick={() => void handleSaveModel()}
            disabled={saving || modelInput.trim() === (modelOverride ?? '')}
            className="flex shrink-0 items-center gap-1 rounded-md bg-accent-soft px-2 py-1.5 text-meta font-medium text-accent hover:bg-accent/20 disabled:opacity-40"
          >
            <Save size={12} /> Save
          </button>
        </div>
      </div>
    </div>
  );
}

function GooseProviderCard({ health, fallbackEnabled, onToggleFallback }: { health: SystemHealth | null; fallbackEnabled: boolean | null; onToggleFallback: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const handleToggle = async () => {
    setBusy(true);
    try { await onToggleFallback(); } finally { setBusy(false); }
  };
  return (
    <div className="space-y-3 rounded-xl border border-border-subtle bg-surface-1 p-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-title font-semibold">Goose</p>
        <span className="text-meta text-fg-muted">failover</span>
      </div>
      {health && (
        <HealthBadge
          ok={!health.goose.configured || health.goose.reachable}
          label={!health.goose.configured ? 'Not configured' : health.goose.reachable ? 'Reachable' : 'Unreachable'}
        />
      )}
      <div className="flex items-center justify-between gap-3">
        <span className="text-caption text-fg-secondary">Fallback enabled</span>
        <ToggleSwitch checked={fallbackEnabled === true} onChange={() => void handleToggle()} disabled={busy || fallbackEnabled === null} label="Goose fallback enabled" />
      </div>
    </div>
  );
}

/**
 * OpenClaw is genuinely experimental and unwired today (confirmed by
 * direct inspection: no production code path ever provisions a cell) -
 * this gives honest, real visibility rather than pretending it's a bigger
 * surface than it is. Clear-quarantine is the one safe, already-
 * implemented write action this subsystem has.
 */
function OpenClawSection({ status, onClearQuarantine }: { status: OpenClawStatus | null; onClearQuarantine: (businessId: string) => Promise<void> }) {
  if (!status) return <p className="text-caption text-fg-muted">Loading…</p>;
  return (
    <div className="space-y-4">
      <p className="text-caption text-fg-secondary">
        Experimental - not yet provisioning any cell in production (no real code path calls it). Real visibility only: cell count, quarantines, and the scheduled security-advisory sweep.
      </p>
      <div className="grid gap-3 sm:grid-cols-3">
        <StatPill label="Cells" value={status.cellCount} />
        <StatPill label="Quarantined" value={status.quarantinedCells.length} />
        <StatPill label="Recent advisories" value={status.recentAdvisories.length} />
      </div>
      <p className="text-caption text-fg-secondary">
        MCP server: <HealthBadge ok={status.mcpServerEnabled} label={status.mcpServerEnabled ? 'Mounted (env)' : 'Not mounted'} />
      </p>
      {status.lastWatcherRun && (
        <p className="text-meta text-fg-muted">
          Last security sweep: {new Date(status.lastWatcherRun.startedAt).toLocaleString()} - {status.lastWatcherRun.status}, {status.lastWatcherRun.advisoriesSeen} advisories seen, {status.lastWatcherRun.cellsQuarantined} quarantined.
        </p>
      )}
      {status.quarantinedCells.length > 0 && (
        <div className="space-y-2">
          <p className="text-caption font-medium text-fg-secondary">Quarantined cells</p>
          {status.quarantinedCells.map((cell) => (
            <div key={cell.businessId} className="flex items-center justify-between gap-3 rounded-lg border border-error/30 bg-error/5 px-3 py-2">
              <div className="min-w-0">
                <p className="truncate text-caption font-medium text-fg">{cell.cellId}</p>
                <p className="truncate text-meta text-fg-muted">{cell.quarantineReason}</p>
              </div>
              <button
                type="button"
                onClick={() => void onClearQuarantine(cell.businessId)}
                className="shrink-0 rounded-md bg-accent-soft px-2 py-1 text-meta font-medium text-accent hover:bg-accent/20"
              >
                Clear quarantine
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const GOVERNANCE_FLAG_LABEL: Record<GovernanceFlagDto['flagType'], string> = {
  high_tool_denial_rate: 'High tool-denial rate',
  high_sentinel_block_rate: 'High Sentinel block rate',
  high_output_leak_rate: 'High output-leak rate',
  high_agent_output_leak_rate: 'High output-leak rate (this agent)',
};

const GOVERNANCE_SEVERITY_COLOR: Record<GovernanceFlagDto['severity'], string> = {
  info: 'bg-info/15 text-info',
  warning: 'bg-warning/15 text-warning',
  critical: 'bg-error/15 text-error',
};

function formatAge(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function GovernanceThresholdsForm({ thresholds, onSave }: { thresholds: GovernanceThresholdsDto | null; onSave: (t: GovernanceThresholdsDto) => Promise<void> }) {
  const [toolDenials, setToolDenials] = useState('');
  const [sentinelBlocks, setSentinelBlocks] = useState('');
  const [outputLeaks, setOutputLeaks] = useState('');
  const [outputLeaksPerAgent, setOutputLeaksPerAgent] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!thresholds) return;
    setToolDenials(String(thresholds.toolDenialsPerHour));
    setSentinelBlocks(String(thresholds.sentinelBlocksPerHour));
    setOutputLeaks(String(thresholds.outputLeaksPerHour));
    setOutputLeaksPerAgent(String(thresholds.outputLeaksPerAgentPerHour));
  }, [thresholds]);

  async function handleSave() {
    setSaving(true); setError(null);
    try {
      await onSave({
        toolDenialsPerHour: Math.max(1, Math.round(Number(toolDenials)) || 1),
        sentinelBlocksPerHour: Math.max(1, Math.round(Number(sentinelBlocks)) || 1),
        outputLeaksPerHour: Math.max(1, Math.round(Number(outputLeaks)) || 1),
        outputLeaksPerAgentPerHour: Math.max(1, Math.round(Number(outputLeaksPerAgent)) || 1),
      });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to save thresholds.');
    } finally {
      setSaving(false);
    }
  }

  if (!thresholds) return null;

  return (
    <div className="space-y-2 rounded-xl border border-border-subtle bg-surface-1 p-4">
      <p className="text-caption font-medium text-fg-secondary">Thresholds (per rolling hour)</p>
      <div className="grid gap-3 sm:grid-cols-4">
        <label className="space-y-1">
          <span className="block text-meta text-fg-muted">Tool denials / agent</span>
          <input type="number" min={1} value={toolDenials} onChange={(e) => setToolDenials(e.target.value)} className="w-full rounded-lg border border-border-subtle bg-surface-2 px-3 py-1.5 text-caption text-fg" />
        </label>
        <label className="space-y-1">
          <span className="block text-meta text-fg-muted">Sentinel blocks / business</span>
          <input type="number" min={1} value={sentinelBlocks} onChange={(e) => setSentinelBlocks(e.target.value)} className="w-full rounded-lg border border-border-subtle bg-surface-2 px-3 py-1.5 text-caption text-fg" />
        </label>
        <label className="space-y-1">
          <span className="block text-meta text-fg-muted">Output leaks / business</span>
          <input type="number" min={1} value={outputLeaks} onChange={(e) => setOutputLeaks(e.target.value)} className="w-full rounded-lg border border-border-subtle bg-surface-2 px-3 py-1.5 text-caption text-fg" />
        </label>
        <label className="space-y-1">
          <span className="block text-meta text-fg-muted">Output leaks / agent</span>
          <input type="number" min={1} value={outputLeaksPerAgent} onChange={(e) => setOutputLeaksPerAgent(e.target.value)} className="w-full rounded-lg border border-border-subtle bg-surface-2 px-3 py-1.5 text-caption text-fg" />
        </label>
      </div>
      <button type="button" onClick={() => void handleSave()} disabled={saving} className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-caption font-medium text-white hover:bg-accent-dim disabled:opacity-50">
        <Save size={13} aria-hidden /> Save thresholds
      </button>
      {error && <p className="text-caption text-error">{error}</p>}
    </div>
  );
}

/**
 * AI Governance & Oversight (v1): threshold-rule flags computed from the
 * existing security_audit_logs trail every 30 minutes - not ML-based
 * drift detection, not compliance-framework mapping. A real, structural
 * guarantee: this sweep runs only from a scheduled job with no HTTP route
 * reachable from an AI agent's own tool-calling path, so an agent can
 * never review or dismiss its own flag.
 */
function GovernanceSection({
  flags, thresholds, onReview, onDismiss, onSaveThresholds,
}: {
  flags: GovernanceFlagDto[] | null;
  thresholds: GovernanceThresholdsDto | null;
  onReview: (id: string) => Promise<void>;
  onDismiss: (id: string) => Promise<void>;
  onSaveThresholds: (t: GovernanceThresholdsDto) => Promise<void>;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);

  async function handleAction(id: string, action: (id: string) => Promise<void>) {
    setBusyId(id);
    try { await action(id); } finally { setBusyId(null); }
  }

  return (
    <div className="space-y-4">
      <p className="text-caption text-fg-secondary">
        Threshold-rule flags computed from the existing security audit trail every 30 minutes - three concrete rules, not ML-based drift detection or a compliance-framework mapping.
      </p>
      <div className="space-y-2">
        {(flags ?? []).map((flag) => (
          <div key={flag.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border-subtle bg-surface-1 p-3">
            <div className="min-w-0">
              <p className="font-medium text-fg">{GOVERNANCE_FLAG_LABEL[flag.flagType]}</p>
              <p className="mt-0.5 truncate text-caption text-fg-muted">
                {flag.businessName ?? 'Unknown business'}{flag.agentName ? ` · agent "${flag.agentName}"` : ''} · {flag.metricValue}/{flag.thresholdValue} in window · {formatAge(flag.createdAt)}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <span className={`rounded-full px-2 py-0.5 text-meta font-medium ${GOVERNANCE_SEVERITY_COLOR[flag.severity]}`}>{flag.severity}</span>
              <button
                type="button"
                onClick={() => void handleAction(flag.id, onReview)}
                disabled={busyId === flag.id}
                className="rounded-md bg-accent-soft px-2 py-1 text-meta font-medium text-accent hover:bg-accent/20 disabled:opacity-50"
              >
                Review
              </button>
              <button
                type="button"
                onClick={() => void handleAction(flag.id, onDismiss)}
                disabled={busyId === flag.id}
                className="rounded-md px-2 py-1 text-meta font-medium text-fg-muted hover:bg-surface-2 disabled:opacity-50"
              >
                Dismiss
              </button>
            </div>
          </div>
        ))}
        {flags?.length === 0 && <p className="text-caption text-fg-muted">No open flags.</p>}
        {flags === null && <p className="text-caption text-fg-muted">Loading…</p>}
      </div>
      <GovernanceThresholdsForm thresholds={thresholds} onSave={onSaveThresholds} />
    </div>
  );
}

const OVERSIGHT_CATEGORY_LABEL: Record<OversightFindingDto['category'], string> = {
  application_health: 'Application Health',
  security: 'Security',
  abuse_spam: 'Abuse & Spam',
  capacity: 'Capacity',
  policy: 'Policy',
  monitoring_gap: 'Monitoring Gap',
};

const OVERSIGHT_SEVERITY_COLOR: Record<OversightFindingDto['severity'], string> = {
  critical: 'bg-error/20 text-error',
  high: 'bg-error/10 text-error',
  medium: 'bg-warning/15 text-warning',
  low: 'bg-info/15 text-info',
  informational: 'bg-fg-muted/15 text-fg-muted',
};

function OversightThresholdsForm({ thresholds, onSave }: { thresholds: OversightThresholdsDto | null; onSave: (t: OversightThresholdsDto) => Promise<void> }) {
  const [fields, setFields] = useState<Record<keyof OversightThresholdsDto, string>>({
    authAbusePerHour: '', recaptchaFailuresPerHour: '', aiUsageGrowthWarningPct: '',
    entitlementWarningPct: '', entitlementCriticalPct: '', connectionCeilingWarningPct: '', configDriftGraceHours: '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!thresholds) return;
    setFields({
      authAbusePerHour: String(thresholds.authAbusePerHour),
      recaptchaFailuresPerHour: String(thresholds.recaptchaFailuresPerHour),
      aiUsageGrowthWarningPct: String(thresholds.aiUsageGrowthWarningPct),
      entitlementWarningPct: String(thresholds.entitlementWarningPct),
      entitlementCriticalPct: String(thresholds.entitlementCriticalPct),
      connectionCeilingWarningPct: String(thresholds.connectionCeilingWarningPct),
      configDriftGraceHours: String(thresholds.configDriftGraceHours),
    });
  }, [thresholds]);

  async function handleSave() {
    setSaving(true); setError(null);
    try {
      const clamp = (v: string, max: number) => Math.min(max, Math.max(1, Math.round(Number(v)) || 1));
      await onSave({
        authAbusePerHour: clamp(fields.authAbusePerHour, 100_000),
        recaptchaFailuresPerHour: clamp(fields.recaptchaFailuresPerHour, 100_000),
        aiUsageGrowthWarningPct: clamp(fields.aiUsageGrowthWarningPct, 10_000),
        entitlementWarningPct: clamp(fields.entitlementWarningPct, 100),
        entitlementCriticalPct: clamp(fields.entitlementCriticalPct, 100),
        connectionCeilingWarningPct: clamp(fields.connectionCeilingWarningPct, 100),
        configDriftGraceHours: clamp(fields.configDriftGraceHours, 24 * 90),
      });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to save thresholds.');
    } finally {
      setSaving(false);
    }
  }

  if (!thresholds) return null;

  const labels: Record<keyof OversightThresholdsDto, string> = {
    authAbusePerHour: 'Auth rate-limit trips / hr',
    recaptchaFailuresPerHour: 'reCAPTCHA failures / hr',
    aiUsageGrowthWarningPct: 'AI usage growth warning %',
    entitlementWarningPct: 'Entitlement warning %',
    entitlementCriticalPct: 'Entitlement critical %',
    connectionCeilingWarningPct: 'Connection ceiling warning %',
    configDriftGraceHours: 'Config-drift grace (hours)',
  };

  return (
    <div className="space-y-2 rounded-xl border border-border-subtle bg-surface-1 p-4">
      <p className="text-caption font-medium text-fg-secondary">Thresholds</p>
      <div className="grid gap-3 sm:grid-cols-4">
        {(Object.keys(labels) as Array<keyof OversightThresholdsDto>).map((key) => (
          <label key={key} className="space-y-1">
            <span className="block text-meta text-fg-muted">{labels[key]}</span>
            <input
              type="number"
              min={1}
              value={fields[key]}
              onChange={(e) => setFields((prev) => ({ ...prev, [key]: e.target.value }))}
              className="w-full rounded-lg border border-border-subtle bg-surface-2 px-3 py-1.5 text-caption text-fg"
            />
          </label>
        ))}
      </div>
      <button type="button" onClick={() => void handleSave()} disabled={saving} className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-caption font-medium text-white hover:bg-accent-dim disabled:opacity-50">
        <Save size={13} aria-hidden /> Save thresholds
      </button>
      {error && <p className="text-caption text-error">{error}</p>}
    </div>
  );
}

function OversightFindingRow({ finding, onChangeStatus }: { finding: OversightFindingDto; onChangeStatus: (id: string, status: 'investigating' | 'resolved' | 'rejected' | 'monitoring') => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  async function handle(status: 'investigating' | 'resolved' | 'rejected' | 'monitoring') {
    setBusy(true);
    try { await onChangeStatus(finding.id, status); } finally { setBusy(false); }
  }
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border-subtle bg-surface-1 p-3">
      <div className="min-w-0">
        <p className="font-medium text-fg">{finding.title}</p>
        <p className="mt-0.5 truncate text-caption text-fg-muted">
          {finding.businessName ?? 'Platform-wide'}{finding.affectedComponent ? ` · ${finding.affectedComponent}` : ''} · seen {finding.occurrenceCount}× · {formatAge(finding.lastDetectedAt)}
          {finding.confidence !== null ? ` · ${Math.round(finding.confidence * 100)}% confidence` : ''}
        </p>
        {(finding.impact !== null || finding.likelihood !== null || finding.exposure !== null || finding.urgency !== null) && (
          <p className="mt-0.5 text-meta text-fg-muted">
            {finding.impact !== null && `Impact ${finding.impact}/5 `}
            {finding.likelihood !== null && `· Likelihood ${finding.likelihood}/5 `}
            {finding.exposure !== null && `· Exposure ${finding.exposure}/5 `}
            {finding.urgency !== null && `· Urgency ${finding.urgency}/5`}
          </p>
        )}
        {finding.recommendedInvestigation && <p className="mt-1 text-caption text-fg-secondary">{finding.recommendedInvestigation}</p>}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <span className={`rounded-full px-2 py-0.5 text-meta font-medium ${OVERSIGHT_SEVERITY_COLOR[finding.severity]}`}>{finding.severity}</span>
        <button type="button" onClick={() => void handle('investigating')} disabled={busy} className="rounded-md bg-accent-soft px-2 py-1 text-meta font-medium text-accent hover:bg-accent/20 disabled:opacity-50">Investigating</button>
        <button type="button" onClick={() => void handle('resolved')} disabled={busy} className="rounded-md bg-success/15 px-2 py-1 text-meta font-medium text-success hover:bg-success/25 disabled:opacity-50">Resolved</button>
        <button type="button" onClick={() => void handle('rejected')} disabled={busy} className="rounded-md px-2 py-1 text-meta font-medium text-fg-muted hover:bg-surface-2 disabled:opacity-50">Dismiss</button>
      </div>
    </div>
  );
}

/**
 * AURA AI Oversight & Reliability Agent: a broader, additional
 * supervisory layer alongside (not a replacement for) AI Governance
 * above - application health, security/abuse, capacity forecasting,
 * config-policy drift, and a "Monitoring Gaps" subsection that stays
 * visible unconditionally (real, honest blind spots, never hidden away).
 * Same structural guarantee: no AI agent's own tool-calling path can
 * reach any route this section calls.
 */
function OversightSection({
  findings, thresholds, onChangeStatus, onSaveThresholds,
}: {
  findings: OversightFindingDto[] | null;
  thresholds: OversightThresholdsDto | null;
  onChangeStatus: (id: string, status: 'investigating' | 'resolved' | 'rejected' | 'monitoring') => Promise<void>;
  onSaveThresholds: (t: OversightThresholdsDto) => Promise<void>;
}) {
  const monitoringGaps = (findings ?? []).filter((f) => f.category === 'monitoring_gap');
  const otherFindings = (findings ?? []).filter((f) => f.category !== 'monitoring_gap');
  const byCategory = new Map<OversightFindingDto['category'], OversightFindingDto[]>();
  for (const finding of otherFindings) {
    const list = byCategory.get(finding.category) ?? [];
    list.push(finding);
    byCategory.set(finding.category, list);
  }

  return (
    <div className="space-y-4">
      <p className="text-caption text-fg-secondary">
        Application health, security/abuse, capacity, and config-policy findings computed from real telemetry every 15 minutes - 100% deterministic checks, no LLM in the detection path. Findings never disappear on their own; a human marks them Investigating, Resolved, or Dismiss.
      </p>

      {[...byCategory.entries()].map(([category, list]) => (
        <div key={category} className="space-y-2">
          <p className="text-caption font-semibold text-fg-secondary">{OVERSIGHT_CATEGORY_LABEL[category]}</p>
          {list.map((finding) => (
            <OversightFindingRow key={finding.id} finding={finding} onChangeStatus={onChangeStatus} />
          ))}
        </div>
      ))}
      {otherFindings.length === 0 && findings !== null && <p className="text-caption text-fg-muted">No open findings.</p>}
      {findings === null && <p className="text-caption text-fg-muted">Loading…</p>}

      {/* Always visible, never collapsed away - real, honest blind spots (directive's own "Monitoring Gaps" requirement). */}
      <div className="space-y-2 rounded-xl border border-dashed border-border-subtle p-3">
        <p className="text-caption font-semibold text-fg-secondary">Monitoring Gaps</p>
        {monitoringGaps.map((finding) => (
          <OversightFindingRow key={finding.id} finding={finding} onChangeStatus={onChangeStatus} />
        ))}
        {monitoringGaps.length === 0 && findings !== null && <p className="text-caption text-fg-muted">None reported yet - the sweep hasn't run, or gap reporting is still initializing.</p>}
      </div>

      <OversightThresholdsForm thresholds={thresholds} onSave={onSaveThresholds} />
    </div>
  );
}

/** Admin-only: promotes an existing CLIENT user (by email - the only identifier an Admin actually knows ahead of time) to a real DEVELOPER account at the chosen tier. */
function PromoteDeveloperForm({ disabled, onPromote }: { disabled: boolean; onPromote: (email: string, tier: 'ADMIN' | 'STANDARD') => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [tier, setTier] = useState<'ADMIN' | 'STANDARD'>('STANDARD');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handlePromote() {
    if (!email.trim()) { setError('Enter a real email address.'); return; }
    setSaving(true);
    setError(null);
    try {
      await onPromote(email.trim(), tier);
      setEmail(''); setTier('STANDARD'); setOpen(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to promote this user.');
    } finally {
      setSaving(false);
    }
  }

  if (disabled) return null;

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="flex items-center gap-1.5 rounded-lg border border-dashed border-border-subtle px-3 py-2 text-caption font-medium text-fg-secondary hover:border-accent hover:text-accent">
        <Plus size={13} aria-hidden /> Promote a user to developer
      </button>
    );
  }

  return (
    <div className="rounded-xl border border-border-subtle bg-surface-1 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="user@example.com"
          className="min-w-48 flex-1 rounded-md border border-border-subtle bg-surface-2 px-2 py-1.5 text-caption text-fg"
        />
        <select value={tier} onChange={(e) => setTier(e.target.value as 'ADMIN' | 'STANDARD')} className="rounded-md border border-border-subtle bg-surface-2 px-2 py-1.5 text-caption text-fg">
          <option value="STANDARD">Standard</option>
          <option value="ADMIN">Admin</option>
        </select>
        <button type="button" onClick={() => void handlePromote()} disabled={saving} className="rounded-md bg-accent px-3 py-1.5 text-caption font-medium text-white disabled:opacity-50">
          {saving ? 'Promoting…' : 'Promote'}
        </button>
        <button type="button" onClick={() => setOpen(false)} className="rounded-md px-2 py-1.5 text-caption text-fg-muted hover:bg-surface-2">Cancel</button>
      </div>
      {error && <p className="mt-2 text-caption text-error">{error}</p>}
    </div>
  );
}

/** New plan creation - the plans/entitlements editing above already covers changing an *existing* plan; this is the missing "create a brand-new tier" affordance. */
function NewPlanForm({ onCreate }: { onCreate: (input: { planKey: string; name: string; priceMonthlyCents: number }) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [planKey, setPlanKey] = useState('');
  const [name, setName] = useState('');
  const [priceMonthly, setPriceMonthly] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleCreate() {
    const priceMonthlyCents = Math.round(Number(priceMonthly) * 100);
    if (!planKey.trim() || !name.trim() || !Number.isFinite(priceMonthlyCents) || priceMonthlyCents < 0) {
      setError('Enter a plan key, name, and a valid monthly price.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onCreate({ planKey: planKey.trim(), name: name.trim(), priceMonthlyCents });
      setPlanKey(''); setName(''); setPriceMonthly(''); setOpen(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create plan.');
    } finally {
      setSaving(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex items-center gap-1.5 rounded-lg border border-dashed border-border-subtle px-3 py-2 text-caption font-medium text-fg-secondary hover:border-accent hover:text-accent"
      >
        <Plus size={13} aria-hidden /> New plan
      </button>
    );
  }

  return (
    <div className="rounded-xl border border-border-subtle bg-surface-1 p-4">
      <p className="mb-3 text-title font-semibold">New plan</p>
      <div className="grid gap-2 sm:grid-cols-3">
        <input value={planKey} onChange={(e) => setPlanKey(e.target.value)} placeholder="plan_key (e.g. pro)" disabled={saving} className="rounded-md border border-border-subtle bg-surface-2 px-2 py-1.5 text-caption text-fg focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50" />
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Display name" disabled={saving} className="rounded-md border border-border-subtle bg-surface-2 px-2 py-1.5 text-caption text-fg focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50" />
        <input value={priceMonthly} onChange={(e) => setPriceMonthly(e.target.value)} type="number" min={0} step="0.01" placeholder="Monthly price" disabled={saving} className="rounded-md border border-border-subtle bg-surface-2 px-2 py-1.5 text-caption text-fg focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50" />
      </div>
      {error && <p className="mt-2 text-caption text-error">{error}</p>}
      <div className="mt-3 flex gap-2">
        <button type="button" onClick={() => void handleCreate()} disabled={saving} className="rounded-lg bg-accent px-3 py-1.5 text-caption font-medium text-white hover:bg-accent-dim disabled:opacity-50">
          {saving ? 'Creating…' : 'Create plan'}
        </button>
        <button type="button" onClick={() => setOpen(false)} className="rounded-lg px-3 py-1.5 text-caption text-fg-secondary hover:text-fg">Cancel</button>
      </div>
    </div>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────

export function DeveloperControlPlanePage() {
  const { user } = useAuth();
  const isDeveloperAdmin = user?.developerTier === 'ADMIN';
  const [stats, setStats] = useState<PlatformStats | null>(null);
  const [health, setHealth] = useState<SystemHealth | null>(null);
  const [aiUsage, setAiUsage] = useState<AiUsageOverview | null>(null);
  const [verticals, setVerticals] = useState<Vertical[]>([]);
  const [accounts, setAccounts] = useState<ProductAccount[]>([]);
  const [plans, setPlans] = useState<DeveloperPlan[]>([]);
  const [paymentProviders, setPaymentProviders] = useState<{ kind: string; configured: boolean; enabled: boolean }[]>([]);
  const [autonomyKillSwitch, setAutonomyKillSwitch] = useState<boolean | null>(null);
  const [globalIntegrations, setGlobalIntegrations] = useState<IntegrationHealth | null>(null);
  const [platformConfig, setPlatformConfig] = useState<PlatformConfig | null>(null);
  const [secretsStatus, setSecretsStatus] = useState<{ name: string; configured: boolean }[]>([]);
  const [openclawStatus, setOpenclawStatus] = useState<OpenClawStatus | null>(null);
  const [governanceFlags, setGovernanceFlags] = useState<GovernanceFlagDto[] | null>(null);
  const [governanceThresholds, setGovernanceThresholds] = useState<GovernanceThresholdsDto | null>(null);
  const [oversightFindings, setOversightFindings] = useState<OversightFindingDto[] | null>(null);
  const [oversightThresholds, setOversightThresholds] = useState<OversightThresholdsDto | null>(null);
  const [platformAccounts, setPlatformAccounts] = useState<DeveloperAccount[]>([]);
  const [changingPlanForBusinessId, setChangingPlanForBusinessId] = useState<string | null>(null);
  const [catalogOpen, setCatalogOpen] = useState(true);
  const [platformTrials, setPlatformTrials] = useState<Awaited<ReturnType<typeof api.getPlatformTrials>>['trials'] | null>(null);
  const [securityEvents, setSecurityEvents] = useState<Awaited<ReturnType<typeof api.getPlatformSecurityEvents>>['events'] | null>(null);
  const [developers, setDevelopers] = useState<Awaited<ReturnType<typeof api.getDevelopers>>['developers'] | null>(null);
  const [trialsDetailOpen, setTrialsDetailOpen] = useState(true);
  const [securityEventsDetailOpen, setSecurityEventsDetailOpen] = useState(true);
  const [developersOpen, setDevelopersOpen] = useState(true);
  const [accountsOpen, setAccountsOpen] = useState(true);
  const [platformAccountsOpen, setPlatformAccountsOpen] = useState(true);
  const [healthOpen, setHealthOpen] = useState(true);
  const [aiUsageOpen, setAiUsageOpen] = useState(true);
  const [plansOpen, setPlansOpen] = useState(true);
  const [paymentProvidersOpen, setPaymentProvidersOpen] = useState(true);
  const [integrationsOpen, setIntegrationsOpen] = useState(true);
  const [aiProvidersOpen, setAiProvidersOpen] = useState(true);
  const [openclawOpen, setOpenclawOpen] = useState(true);
  const [governanceOpen, setGovernanceOpen] = useState(true);
  const [oversightOpen, setOversightOpen] = useState(true);

  function loadPlatformConfig() {
    api.getPlatformConfig().then(setPlatformConfig).catch(() => undefined);
  }

  useEffect(() => {
    api.getControlPlaneStats().then((r) => setStats(r.stats)).catch(() => undefined);
    api.getSystemHealth().then(setHealth).catch(() => undefined);
    api.getAiUsageOverview().then(setAiUsage).catch(() => undefined);
    api.listVerticals().then((r) => setVerticals(r.verticals)).catch(() => undefined);
    api.listAllProductAccountsDev().then((r) => setAccounts(r.accounts)).catch(() => undefined);
    api.listPlans().then((r) => setPlans(r.plans)).catch(() => undefined);
    api.listPaymentProviders().then((r) => setPaymentProviders(r.providers)).catch(() => undefined);
    api.getAutonomyKillSwitch().then((r) => setAutonomyKillSwitch(r.enabled)).catch(() => undefined);
    api.getGlobalIntegrationStatus().then(setGlobalIntegrations).catch(() => undefined);
    loadPlatformConfig();
    api.getSecretsStatus().then((r) => setSecretsStatus(r.secrets)).catch(() => undefined);
    api.getOpenClawStatus().then(setOpenclawStatus).catch(() => undefined);
    api.getDeveloperAccounts().then((r) => setPlatformAccounts(r.accounts)).catch(() => undefined);
    api.getGovernanceFlags().then((r) => setGovernanceFlags(r.flags)).catch(() => undefined);
    api.getGovernanceThresholds().then((r) => setGovernanceThresholds(r.thresholds)).catch(() => undefined);
    api.getOversightFindings().then((r) => setOversightFindings(r.findings)).catch(() => undefined);
    api.getOversightThresholds().then((r) => setOversightThresholds(r.thresholds)).catch(() => undefined);
    api.getPlatformTrials().then((r) => setPlatformTrials(r.trials)).catch(() => undefined);
    api.getPlatformSecurityEvents().then((r) => setSecurityEvents(r.events)).catch(() => undefined);
    api.getDevelopers().then((r) => setDevelopers(r.developers)).catch(() => undefined);
  }, []);

  const handlePromoteDeveloper = async (email: string, tier: 'ADMIN' | 'STANDARD') => {
    await api.promoteDeveloper(email, tier);
    api.getDevelopers().then((r) => setDevelopers(r.developers)).catch(() => undefined);
  };
  const handleSetDeveloperTier = async (userId: string, tier: 'ADMIN' | 'STANDARD') => {
    await api.setDeveloperTier(userId, tier);
    setDevelopers((prev) => (prev ? prev.map((d) => (d.id === userId ? { ...d, developerTier: tier } : d)) : prev));
  };
  const handleDemoteDeveloper = async (userId: string) => {
    await api.demoteDeveloper(userId);
    setDevelopers((prev) => (prev ? prev.filter((d) => d.id !== userId) : prev));
  };

  const handleReviewGovernanceFlag = async (id: string) => {
    await api.reviewGovernanceFlag(id);
    setGovernanceFlags((prev) => (prev ? prev.filter((f) => f.id !== id) : prev));
  };

  const handleDismissGovernanceFlag = async (id: string) => {
    await api.dismissGovernanceFlag(id);
    setGovernanceFlags((prev) => (prev ? prev.filter((f) => f.id !== id) : prev));
  };

  const handleSaveGovernanceThresholds = async (thresholds: GovernanceThresholdsDto) => {
    const { thresholds: saved } = await api.setGovernanceThresholds(thresholds);
    setGovernanceThresholds(saved);
  };

  const handleChangeOversightFindingStatus = async (id: string, status: 'investigating' | 'resolved' | 'rejected' | 'monitoring') => {
    const { finding } = await api.changeOversightFindingStatus(id, status);
    // 'resolved'/'rejected' are terminal - listOpenAcrossPlatform never
    // returns them again, so remove locally. 'investigating'/'monitoring'
    // stay open - update in place rather than incorrectly disappearing.
    setOversightFindings((prev) => {
      if (!prev) return prev;
      if (finding.status === 'resolved' || finding.status === 'rejected') return prev.filter((f) => f.id !== finding.id);
      return prev.map((f) => (f.id === finding.id ? finding : f));
    });
  };

  const handleSaveOversightThresholds = async (thresholds: OversightThresholdsDto) => {
    const { thresholds: saved } = await api.setOversightThresholds(thresholds);
    setOversightThresholds(saved);
  };

  const handleTogglePaymentProvider = async (kind: string, enabled: boolean) => {
    await api.togglePaymentProvider(kind, enabled);
    setPaymentProviders((prev) => prev.map((p) => (p.kind === kind ? { ...p, enabled } : p)));
  };

  const handleToggleAutonomyKillSwitch = async () => {
    const next = !autonomyKillSwitch;
    await api.setAutonomyKillSwitch(next);
    setAutonomyKillSwitch(next);
  };

  const handleSetPlatformConfig = async (key: string, value: unknown) => {
    await api.setPlatformConfig(key, value);
    loadPlatformConfig();
  };

  const handleClearOpenClawQuarantine = async (businessId: string) => {
    await api.clearOpenClawQuarantine(businessId);
    api.getOpenClawStatus().then(setOpenclawStatus).catch(() => undefined);
  };

  const handleCreatePlan = async (input: { planKey: string; name: string; priceMonthlyCents: number }) => {
    const { plan } = await api.createPlan(input);
    setPlans((prev) => [...prev, plan]);
  };

  /**
   * The manual override for a real payment that fell outside the
   * automated verify-then-apply webhook flow (a missed webhook, a
   * provider not wired, an out-of-band payment) - see
   * developerAccountsService.ts's own doc comment.
   */
  const handleChangeBusinessPlan = async (businessId: string, planKey: string) => {
    setChangingPlanForBusinessId(businessId);
    try {
      await api.setBusinessPlan(businessId, planKey);
      const { accounts } = await api.getDeveloperAccounts();
      setPlatformAccounts(accounts);
    } finally {
      setChangingPlanForBusinessId(null);
    }
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

        {/* ── Global Kill Switches - always visible, never buried in a collapsible group ── */}
        <section className="space-y-3 rounded-2xl border border-border-subtle bg-surface-1 p-5">
          <p className="text-title font-semibold">Global Kill Switches</p>
          <div className={`rounded-xl border p-4 ${autonomyKillSwitch ? 'border-error/50 bg-error/5' : 'border-border-subtle bg-surface-2'}`}>
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-start gap-3">
                <ShieldCheck size={18} className={`mt-0.5 shrink-0 ${autonomyKillSwitch ? 'text-error' : 'text-accent'}`} />
                <div>
                  <p className="text-body font-semibold">Autonomy sweep</p>
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
          </div>
          <KillSwitchRow
            title="Goose fallback"
            description="Stops the app from falling back to Goose when Gemini fails, platform-wide. Reply generation still tries Gemini normally - this only removes the last-resort failover."
            checked={platformConfig?.gooseFallbackEnabled ?? null}
            onToggle={() => handleSetPlatformConfig('goose_fallback_enabled', { enabled: !(platformConfig?.gooseFallbackEnabled ?? true) })}
          />
          <KillSwitchRow
            title="Registration paused"
            description="Blocks new trial signups and the single-tenant bootstrap registration platform-wide, immediately. Existing businesses are completely unaffected."
            checked={platformConfig?.registrationPaused ?? null}
            onToggle={() => handleSetPlatformConfig('registration_paused', { enabled: !(platformConfig?.registrationPaused ?? false) })}
          />
          <KillSwitchRow
            title="Maintenance mode"
            description="Every non-developer request to the app gets a real 503 immediately - health checks, login, and every /developer/* route (including this page) always stay reachable, so this can never lock out the developer who flipped it on."
            checked={platformConfig?.maintenanceMode ?? null}
            onToggle={() => handleSetPlatformConfig('maintenance_mode', { enabled: !(platformConfig?.maintenanceMode ?? false) })}
          />
        </section>

        {/* Stats */}
        <section className="grid gap-3 sm:grid-cols-5">
          <StatPill label="Total clients"          value={stats?.totalBusinesses ?? null} to="#client-accounts" />
          <StatPill label="Active connections"     value={stats?.activeWaConnections ?? null} to="/settings" />
          <StatPill label="AI agents"              value={stats?.totalAiAgents ?? null} to="/agents" />
          <StatPill label="Active trials"          value={stats?.activeTrials ?? null} to="#trials-detail" />
          <StatPill label="Security events (24h)"  value={stats?.recentSecurityEvents ?? null} to="#security-events-detail" />
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
        {/* ── Accounts — real, cross-tenant: phone number (numeric order), signup date, trial/plan status, including the developer's own account ── */}
        <section className="rounded-2xl border border-border-subtle bg-surface-1 overflow-hidden">
          <button
            type="button"
            onClick={() => setPlatformAccountsOpen((o) => !o)}
            className="flex w-full items-center gap-3 px-6 py-4 text-left hover:bg-surface-2 transition-colors"
          >
            <Users size={18} className="shrink-0 text-accent" />
            <span className="flex-1 text-title font-semibold">Accounts</span>
            <span className="text-caption text-fg-muted">{platformAccounts.length} accounts</span>
            {platformAccountsOpen
              ? <ChevronDown size={16} className="shrink-0 text-fg-muted" />
              : <ChevronRight size={16} className="shrink-0 text-fg-muted" />}
          </button>
          {platformAccountsOpen && (
            <div className="border-t border-border-subtle px-6 pb-6 pt-4">
              <p className="mb-4 text-caption text-fg-secondary">
                Every real account on the platform, including your own - sorted by phone number in numeric order. Use "Change plan" for a payment that never came through the automated checkout (a missed webhook, cash, an out-of-band transfer).
              </p>
              {platformAccounts.length === 0 ? (
                <p className="text-caption text-fg-muted">Loading…</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-caption">
                    <thead>
                      <tr className="border-b border-border-subtle text-fg-muted">
                        <th className="py-2 pr-4 font-medium">Phone number</th>
                        <th className="py-2 pr-4 font-medium">Signed up</th>
                        <th className="py-2 pr-4 font-medium">Business</th>
                        <th className="py-2 pr-4 font-medium">Status</th>
                        <th className="py-2 pr-4 font-medium">Plan</th>
                        <th className="py-2 font-medium">Change plan</th>
                      </tr>
                    </thead>
                    <tbody>
                      {platformAccounts.map((account) => (
                        <PlatformAccountRow
                          key={account.userId}
                          account={account}
                          plans={plans}
                          busy={changingPlanForBusinessId === account.businessId}
                          onChangePlan={handleChangeBusinessPlan}
                        />
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </section>

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
              <div className="mb-4">
                <NewPlanForm onCreate={handleCreatePlan} />
              </div>
              {plans.length === 0 ? (
                <p className="text-caption text-fg-muted">Loading…</p>
              ) : (
                <div className="grid gap-4 lg:grid-cols-2">
                  {plans.map((plan) => (
                    <PlanCard key={plan.id} plan={plan} onUpdatePlan={handleUpdatePlan} onUpdateEntitlement={handleUpdateEntitlement} />
                  ))}
                </div>
              )}

              <div className="mt-4 grid gap-4 lg:grid-cols-2">
                <TokenTopupCatalogEditor catalog={platformConfig?.aiTokenTopupCatalog} onSaved={loadPlatformConfig} />
                <MemoryTopupCatalogEditor catalog={platformConfig?.aiMemoryTopupCatalog} onSaved={loadPlatformConfig} />
              </div>
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
        {/* ── Global integration status (platform infra, not any one business's connections) ── */}
        <section className="rounded-2xl border border-border-subtle bg-surface-1 overflow-hidden">
          <button
            type="button"
            onClick={() => setIntegrationsOpen((o) => !o)}
            className="flex w-full items-center gap-3 px-6 py-4 text-left hover:bg-surface-2 transition-colors"
          >
            <PlugZap size={18} className="shrink-0 text-accent" />
            <span className="flex-1 text-title font-semibold">Integrations — Global Status</span>
            <span className="text-caption text-fg-muted">
              {globalIntegrations ? `${globalIntegrations.integrations.filter((i) => i.state === 'connected').length}/${globalIntegrations.integrations.length} configured` : '…'}
            </span>
            {integrationsOpen
              ? <ChevronDown size={16} className="shrink-0 text-fg-muted" />
              : <ChevronRight size={16} className="shrink-0 text-fg-muted" />}
          </button>
          {integrationsOpen && (
            <div className="border-t border-border-subtle px-6 pb-6 pt-4">
              <p className="mb-4 text-caption text-fg-secondary">
                The platform's own integration infrastructure - whether each provider's server credentials are configured at all, not whether any one business is connected. Real per-business connections live on that business's own Integrations page.
              </p>
              {globalIntegrations ? <IntegrationHealthList health={globalIntegrations} compact /> : <p className="text-caption text-fg-muted">Loading…</p>}
            </div>
          )}
        </section>

        {/* ── AI Providers — embedded, replaces the old "AI providers" link-out card ── */}
        <section className="rounded-2xl border border-border-subtle bg-surface-1 overflow-hidden">
          <button
            type="button"
            onClick={() => setAiProvidersOpen((o) => !o)}
            className="flex w-full items-center gap-3 px-6 py-4 text-left hover:bg-surface-2 transition-colors"
          >
            <Gauge size={18} className="shrink-0 text-accent" />
            <span className="flex-1 text-title font-semibold">AI Providers</span>
            {aiProvidersOpen
              ? <ChevronDown size={16} className="shrink-0 text-fg-muted" />
              : <ChevronRight size={16} className="shrink-0 text-fg-muted" />}
          </button>
          {aiProvidersOpen && (
            <div className="space-y-4 border-t border-border-subtle px-6 pb-6 pt-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <GeminiProviderCard
                  modelOverride={platformConfig?.geminiModelOverride ?? null}
                  onSetModelOverride={(model) => handleSetPlatformConfig('gemini_model_override', { model })}
                />
                <GooseProviderCard
                  health={health}
                  fallbackEnabled={platformConfig?.gooseFallbackEnabled ?? null}
                  onToggleFallback={() => handleSetPlatformConfig('goose_fallback_enabled', { enabled: !(platformConfig?.gooseFallbackEnabled ?? true) })}
                />
              </div>
              <div>
                <p className="mb-2 text-caption font-medium text-fg-secondary">AI providers, in the gateway's real fallback order</p>
                <div className="mb-2.5 rounded-xl border border-border-subtle bg-surface-2 p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-caption font-semibold text-fg">Automatic capability routing</span>
                    <HealthBadge ok={true} label="Active" />
                  </div>
                  <p className="mt-1.5 text-meta leading-5 text-fg-secondary">
                    Aura picks the first eligible provider by capability and fallback order. A turn that needs tools only ever
                    reaches a provider that advertises tool calling; the two text-only providers at the bottom genuinely cannot
                    run a tool, so a reply that needed one escalates to a human instead of pretending the action happened.
                    A provider with no API key is never registered at all.
                  </p>
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  <AiProviderCard name="Gemini" role="primary" priority={10} secretName="GEMINI_API_KEY" secrets={secretsStatus} capabilities={['Chat', 'Tool calling', 'Vision', 'Audio']} />
                  <AiProviderCard name="OpenAI" role="tool-capable fallback" priority={20} secretName="OPENAI_API_KEY" secrets={secretsStatus} capabilities={['Chat', 'Tool calling', 'JSON']} />
                  <AiProviderCard name="Groq" role="tool-capable fallback" priority={25} secretName="GROQ_API_KEY" secrets={secretsStatus} capabilities={['Chat', 'Tool calling']} />
                  <AiProviderCard name="Cerebras" role="tool-capable fallback" priority={30} secretName="CEREBRAS_API_KEY" secrets={secretsStatus} capabilities={['Chat', 'Tool calling']} />
                  <AiProviderCard name="Mistral" role="tool-capable fallback" priority={35} secretName="MISTRAL_API_KEY" secrets={secretsStatus} capabilities={['Chat', 'Tool calling', 'JSON']} />
                  <AiProviderCard name="OpenRouter" role="text-only compatibility fallback" priority={40} secretName="OPENROUTER_API_KEY" secrets={secretsStatus} capabilities={['Chat']} />
                  <AiProviderCard name="Goose" role="text-only emergency fallback" priority={50} secretName="GOOSE_SERVICE_API_KEY" secrets={secretsStatus} capabilities={['Chat']} />
                </div>
              </div>
              <div>
                <p className="mb-2 text-caption font-medium text-fg-secondary">Secrets configured (status only - never editable here; changing a real secret still means updating the environment and restarting)</p>
                <SecretsChecklist secrets={secretsStatus} />
              </div>
            </div>
          )}
        </section>

        {/* ── OpenClaw — embedded, honest visibility for a genuinely experimental subsystem ── */}
        <section className="rounded-2xl border border-border-subtle bg-surface-1 overflow-hidden">
          <button
            type="button"
            onClick={() => setOpenclawOpen((o) => !o)}
            className="flex w-full items-center gap-3 px-6 py-4 text-left hover:bg-surface-2 transition-colors"
          >
            <PlugZap size={18} className="shrink-0 text-accent" />
            <span className="flex-1 text-title font-semibold">OpenClaw</span>
            <span className="text-caption text-fg-muted">{openclawStatus ? `${openclawStatus.cellCount} cells` : '…'}</span>
            {openclawOpen
              ? <ChevronDown size={16} className="shrink-0 text-fg-muted" />
              : <ChevronRight size={16} className="shrink-0 text-fg-muted" />}
          </button>
          {openclawOpen && (
            <div className="border-t border-border-subtle px-6 pb-6 pt-4">
              <OpenClawSection status={openclawStatus} onClearQuarantine={handleClearOpenClawQuarantine} />
            </div>
          )}
        </section>

        {/* ── AI Governance — threshold-rule flags over the existing audit trail ── */}
        <section className="rounded-2xl border border-border-subtle bg-surface-1 overflow-hidden">
          <button
            type="button"
            onClick={() => setGovernanceOpen((o) => !o)}
            className="flex w-full items-center gap-3 px-6 py-4 text-left hover:bg-surface-2 transition-colors"
          >
            <ShieldAlert size={18} className="shrink-0 text-accent" />
            <span className="flex-1 text-title font-semibold">AI Governance</span>
            <span className="text-caption text-fg-muted">{governanceFlags ? `${governanceFlags.length} open` : '…'}</span>
            {governanceOpen
              ? <ChevronDown size={16} className="shrink-0 text-fg-muted" />
              : <ChevronRight size={16} className="shrink-0 text-fg-muted" />}
          </button>
          {governanceOpen && (
            <div className="border-t border-border-subtle px-6 pb-6 pt-4">
              <GovernanceSection
                flags={governanceFlags}
                thresholds={governanceThresholds}
                onReview={handleReviewGovernanceFlag}
                onDismiss={handleDismissGovernanceFlag}
                onSaveThresholds={handleSaveGovernanceThresholds}
              />
            </div>
          )}
        </section>

        {/* ── AURA AI Oversight & Reliability Agent — application health, security/abuse, capacity, policy, and honest monitoring gaps ── */}
        <section className="rounded-2xl border border-border-subtle bg-surface-1 overflow-hidden">
          <button
            type="button"
            onClick={() => setOversightOpen((o) => !o)}
            className="flex w-full items-center gap-3 px-6 py-4 text-left hover:bg-surface-2 transition-colors"
          >
            <Radar size={18} className="shrink-0 text-accent" />
            <span className="flex-1 text-title font-semibold">AI Oversight & Reliability</span>
            <span className="text-caption text-fg-muted">{oversightFindings ? `${oversightFindings.length} open` : '…'}</span>
            {oversightOpen
              ? <ChevronDown size={16} className="shrink-0 text-fg-muted" />
              : <ChevronRight size={16} className="shrink-0 text-fg-muted" />}
          </button>
          {oversightOpen && (
            <div className="border-t border-border-subtle px-6 pb-6 pt-4">
              <OversightSection
                findings={oversightFindings}
                thresholds={oversightThresholds}
                onChangeStatus={handleChangeOversightFindingStatus}
                onSaveThresholds={handleSaveOversightThresholds}
              />
            </div>
          )}
        </section>

        {/* ── Real detail behind the "Active trials" stat pill ── */}
        <section id="trials-detail" className="rounded-2xl border border-border-subtle bg-surface-1 overflow-hidden">
          <button type="button" onClick={() => setTrialsDetailOpen((o) => !o)} className="flex w-full items-center gap-3 px-6 py-4 text-left hover:bg-surface-2 transition-colors">
            <Users size={18} className="shrink-0 text-accent" />
            <span className="flex-1 text-title font-semibold">Active Trials</span>
            <span className="text-caption text-fg-muted">{platformTrials ? `${platformTrials.filter((t) => (t.state === 'ACTIVE' || t.state === 'EXPIRING') && t.endsAt && new Date(t.endsAt) > new Date()).length} active` : '…'}</span>
            {trialsDetailOpen ? <ChevronDown size={16} className="shrink-0 text-fg-muted" /> : <ChevronRight size={16} className="shrink-0 text-fg-muted" />}
          </button>
          {trialsDetailOpen && (
            <div className="space-y-2 border-t border-border-subtle px-6 pb-6 pt-4">
              {(platformTrials ?? []).map((trial) => {
                const genuinelyActive = (trial.state === 'ACTIVE' || trial.state === 'EXPIRING') && !!trial.endsAt && new Date(trial.endsAt) > new Date();
                return (
                  <div key={trial.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border-subtle bg-surface-2 p-3">
                    <div className="min-w-0">
                      <p className="font-medium text-fg">{trial.email}</p>
                      <p className="mt-0.5 truncate text-caption text-fg-muted">{trial.productKey} · started {trial.startsAt ? new Date(trial.startsAt).toLocaleDateString() : '—'} · ends {trial.endsAt ? new Date(trial.endsAt).toLocaleDateString() : '—'}</p>
                    </div>
                    <span className={`rounded-full px-2 py-0.5 text-meta font-medium ${genuinelyActive ? 'bg-accent-soft text-accent' : 'bg-surface-3 text-fg-muted'}`}>
                      {genuinelyActive ? trial.state : 'expired'}
                    </span>
                  </div>
                );
              })}
              {platformTrials?.length === 0 && <p className="text-caption text-fg-muted">No trials recorded.</p>}
              {platformTrials === null && <p className="text-caption text-fg-muted">Loading…</p>}
            </div>
          )}
        </section>

        {/* ── Real detail behind the "Security events (24h)" stat pill ── */}
        <section id="security-events-detail" className="rounded-2xl border border-border-subtle bg-surface-1 overflow-hidden">
          <button type="button" onClick={() => setSecurityEventsDetailOpen((o) => !o)} className="flex w-full items-center gap-3 px-6 py-4 text-left hover:bg-surface-2 transition-colors">
            <ShieldCheck size={18} className="shrink-0 text-accent" />
            <span className="flex-1 text-title font-semibold">Security Events (24h)</span>
            <span className="text-caption text-fg-muted">{securityEvents ? `${securityEvents.length} events` : '…'}</span>
            {securityEventsDetailOpen ? <ChevronDown size={16} className="shrink-0 text-fg-muted" /> : <ChevronRight size={16} className="shrink-0 text-fg-muted" />}
          </button>
          {securityEventsDetailOpen && (
            <div className="max-h-96 space-y-1.5 overflow-y-auto border-t border-border-subtle px-6 pb-6 pt-4">
              {(securityEvents ?? []).map((event) => (
                <div key={event.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border-subtle bg-surface-2 px-3 py-2">
                  <div className="min-w-0">
                    <p className="truncate text-caption font-medium text-fg">{event.eventType}</p>
                    <p className="truncate text-meta text-fg-muted">{event.businessName ?? 'Platform-wide'} · {formatAge(event.createdAt)}</p>
                  </div>
                  <span className={`rounded-full px-2 py-0.5 text-meta font-medium ${GOVERNANCE_SEVERITY_COLOR[event.severity as keyof typeof GOVERNANCE_SEVERITY_COLOR] ?? 'bg-surface-3 text-fg-secondary'}`}>{event.severity}</span>
                </div>
              ))}
              {securityEvents?.length === 0 && <p className="text-caption text-fg-muted">No security events in this window.</p>}
              {securityEvents === null && <p className="text-caption text-fg-muted">Loading…</p>}
            </div>
          )}
        </section>

        {/* ── Developer-tier management (migration 1002) - the one Admin-only surface; every other section on this page stays open to any developer ── */}
        <section className="rounded-2xl border border-border-subtle bg-surface-1 overflow-hidden">
          <button type="button" onClick={() => setDevelopersOpen((o) => !o)} className="flex w-full items-center gap-3 px-6 py-4 text-left hover:bg-surface-2 transition-colors">
            <KeyRound size={18} className="shrink-0 text-accent" />
            <span className="flex-1 text-title font-semibold">Developers</span>
            <span className="text-caption text-fg-muted">{developers ? `${developers.length} developers` : '…'}</span>
            {developersOpen ? <ChevronDown size={16} className="shrink-0 text-fg-muted" /> : <ChevronRight size={16} className="shrink-0 text-fg-muted" />}
          </button>
          {developersOpen && (
            <div className="space-y-2 border-t border-border-subtle px-6 pb-6 pt-4">
              {!isDeveloperAdmin && (
                <p className="rounded-lg bg-surface-2 px-3 py-2 text-caption text-fg-muted">Admin only - you can see this list, but promoting, demoting, or changing a developer's tier requires the Admin tier.</p>
              )}
              {(developers ?? []).map((dev) => (
                <div key={dev.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border-subtle bg-surface-2 p-3">
                  <div className="min-w-0">
                    <p className="font-medium text-fg">{dev.displayName}</p>
                    <p className="truncate text-caption text-fg-muted">{dev.email}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <select
                      value={dev.developerTier ?? 'STANDARD'}
                      disabled={!isDeveloperAdmin}
                      onChange={(e) => void handleSetDeveloperTier(dev.id, e.target.value as 'ADMIN' | 'STANDARD')}
                      title={!isDeveloperAdmin ? 'Admin only' : undefined}
                      className="rounded-md border border-border-subtle bg-surface-1 px-2 py-1 text-meta font-medium text-fg disabled:opacity-50"
                    >
                      <option value="ADMIN">Admin</option>
                      <option value="STANDARD">Standard</option>
                    </select>
                    <button
                      type="button"
                      disabled={!isDeveloperAdmin}
                      title={!isDeveloperAdmin ? 'Admin only' : undefined}
                      onClick={() => void handleDemoteDeveloper(dev.id)}
                      className="rounded-md px-2 py-1 text-meta font-medium text-error hover:bg-error/10 disabled:opacity-50"
                    >
                      Remove
                    </button>
                  </div>
                </div>
              ))}
              {developers?.length === 0 && <p className="text-caption text-fg-muted">No developer accounts.</p>}
              {developers === null && <p className="text-caption text-fg-muted">Loading…</p>}
              <PromoteDeveloperForm disabled={!isDeveloperAdmin} onPromote={handlePromoteDeveloper} />
            </div>
          )}
        </section>

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
        <section id="client-accounts" className="rounded-2xl border border-border-subtle bg-surface-1 overflow-hidden">
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
