import { useEffect, useState, type ComponentType } from 'react';
import type { LucideProps } from 'lucide-react';
import {
  Activity, Bot, CreditCard, Database, Gauge, KeyRound, Radio, ShieldCheck, Users,
  Building2, CookingPot, ShoppingBag, Scissors, Car, Stethoscope, Scale, Hotel,
  HardHat, Package, ChevronDown, ChevronRight, LayoutGrid, Check, HeartPulse, X,
} from 'lucide-react';
import { api } from '../lib/api.js';

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

// ── Main page ──────────────────────────────────────────────────────────────

export function DeveloperControlPlanePage() {
  const [stats, setStats] = useState<PlatformStats | null>(null);
  const [health, setHealth] = useState<SystemHealth | null>(null);
  const [verticals, setVerticals] = useState<Vertical[]>([]);
  const [accounts, setAccounts] = useState<ProductAccount[]>([]);
  const [catalogOpen, setCatalogOpen] = useState(true);
  const [accountsOpen, setAccountsOpen] = useState(true);
  const [healthOpen, setHealthOpen] = useState(true);

  useEffect(() => {
    api.getControlPlaneStats().then((r) => setStats(r.stats)).catch(() => undefined);
    api.getSystemHealth().then(setHealth).catch(() => undefined);
    api.listVerticals().then((r) => setVerticals(r.verticals)).catch(() => undefined);
    api.listAllProductAccountsDev().then((r) => setAccounts(r.accounts)).catch(() => undefined);
  }, []);

  const handleAssign = (businessId: string, productKey: string) => {
    setAccounts((prev) =>
      prev.map((a) => (a.businessId === businessId ? { ...a, productKey } : a)),
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
