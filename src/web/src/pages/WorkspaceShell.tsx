import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { Search, ArrowLeft } from 'lucide-react';
import { api, type SyncStatusResponse, type WhatsAppConnectionSnapshot, type WorkspaceBillingEntitlement } from '../lib/api.js';
import { SaasNavRail, SaasNavBottomBar } from '../components/SaasNavRail.js';
import { NotificationCenter } from '../components/NotificationCenter.js';
import { CommandPalette } from '../components/CommandPalette.js';
import { AccountMenu } from '../components/AccountMenu.js';
import { AlertNotifier } from '../components/AlertNotifier.js';
const ChatsRoute = lazy(() => import('./ChatsRoute.js').then((m) => ({ default: m.ChatsRoute })));
const AgentsPage = lazy(() => import('./AgentsPage.js').then((m) => ({ default: m.AgentsPage })));
const CrmRoute = lazy(() => import('./CrmRoute.js').then((m) => ({ default: m.CrmRoute })));
const BillingRoute = lazy(() => import('./BillingRoute.js').then((m) => ({ default: m.BillingRoute })));
const PlanCheckoutRoute = lazy(() => import('./PlanCheckoutRoute.js').then((m) => ({ default: m.PlanCheckoutRoute })));
const SettingsRoute = lazy(() => import('./SettingsRoute.js').then((m) => ({ default: m.SettingsRoute })));
const DashboardRoute = lazy(() => import('./DashboardRoute.js').then((m) => ({ default: m.DashboardRoute })));
const MarketingRoute = lazy(() => import('./MarketingRoute.js').then((m) => ({ default: m.MarketingRoute })));
const EmailRoute = lazy(() => import('./EmailRoute.js').then((m) => ({ default: m.EmailRoute })));
const FunnelsRoute = lazy(() => import('./FunnelsRoute.js').then((m) => ({ default: m.FunnelsRoute })));
const PropertyOperationsPage = lazy(() => import('./PropertyOperationsPage.js').then((m) => ({ default: m.PropertyOperationsPage })));
const RetailOperationsPage = lazy(() => import('./RetailOperationsPage.js').then((m) => ({ default: m.RetailOperationsPage })));
const ProductDashboardPage = lazy(() => import('./ProductDashboardPage.js').then((m) => ({ default: m.ProductDashboardPage })));
const FoodOperationsPage = lazy(() => import('./FoodOperationsPage.js').then((m) => ({ default: m.FoodOperationsPage })));
const PlaceholderPage = lazy(() => import('./PlaceholderPage.js').then((m) => ({ default: m.PlaceholderPage })));
const DeveloperControlPlanePage = lazy(() => import('./DeveloperControlPlanePage.js').then((m) => ({ default: m.DeveloperControlPlanePage })));
const InvoicesPage = lazy(() => import('./InvoicesPage.js').then((m) => ({ default: m.InvoicesPage })));
const TrendsRoute = lazy(() => import('./TrendsRoute.js').then((m) => ({ default: m.TrendsRoute })));
const ListsRoute = lazy(() => import('./ListsRoute.js').then((m) => ({ default: m.ListsRoute })));
const ActivityLogPage = lazy(() => import('./ActivityLogPage.js').then((m) => ({ default: m.ActivityLogPage })));
const ApprovalsPage = lazy(() => import('./ApprovalsPage.js').then((m) => ({ default: m.ApprovalsPage })));
const AppointmentsPage = lazy(() => import('./AppointmentsPage.js').then((m) => ({ default: m.AppointmentsPage })));
const IntegrationHealthPage = lazy(() => import('./IntegrationHealthPage.js').then((m) => ({ default: m.IntegrationHealthPage })));

function RouteFallback() { return <div className="flex h-full flex-1 items-center justify-center text-caption text-fg-muted">Loading…</div>; }

/**
 * A real per-session Aura navigation stack, distinct from raw browser
 * history - navigate(-1) alone can't safely handle a route reached via a
 * refresh or a direct/deep link (no browser history to go back into)
 * without risking leaving the app entirely, and it can't express "go back
 * ONE LEVEL of the actual hierarchy visited" when that hierarchy is
 * several routes deep. This records only the Aura routes actually visited
 * this page load, in order (deduping immediate repeats) - "back" pops the
 * real, actual sequence the user followed. When only one entry has ever
 * been recorded (a fresh load/refresh/deep link - nothing to pop), it
 * falls back to the parent implied by the path itself (strip the last
 * "/segment"), e.g. /billing/plans/growth -> /billing - never a fixed
 * dashboard redirect, and never anything touching authentication/session
 * state (this only ever calls react-router's own navigate() with an
 * in-app path).
 */
function useAppBackNavigation() {
  const location = useLocation();
  const navigate = useNavigate();
  const stackRef = useRef<string[]>([location.pathname]);

  useEffect(() => {
    const stack = stackRef.current;
    if (stack[stack.length - 1] !== location.pathname) stack.push(location.pathname);
  }, [location.pathname]);

  return useCallback(() => {
    const stack = stackRef.current;
    if (stack.length > 1) {
      stack.pop();
      navigate(stack[stack.length - 1] as string);
      return;
    }
    const current = location.pathname;
    const lastSlash = current.lastIndexOf('/');
    const parent = lastSlash > 0 ? current.slice(0, lastSlash) : '';
    navigate(parent || '/dashboard');
  }, [location.pathname, navigate]);
}

/**
 * One shared back arrow for every SaaS page reached from SaasNavRail
 * (Dashboard, Trends, CRM, Billing, Settings, etc.) - rendered once here
 * rather than duplicated into each page component. Real, confirmed gap
 * this used to leave: /chats was excluded on the theory that "the inbox
 * has its own distinct navigation," but ChatThread.tsx's own back arrow
 * only ever handles thread -> chat list (and only on mobile, md:hidden) -
 * nothing let a person leave the Inbox section entirely back to wherever
 * they were before. No longer excluded; the two arrows serve different
 * levels (this one leaves Inbox, ChatThread's own handles within it) and
 * never overlap in when they're shown.
 *
 * Lives inline in the persistent top header bar's left-side cluster,
 * beside the global search button - not a floating overlay on the routed
 * content area. A fixed position over routed content worked for most
 * pages but collided with Email's own 3-pane layout (its tools panel
 * already used that top-right corner) - the header bar is the one place
 * common to every page that never has page-specific content in it, so
 * this placement can never collide again regardless of what a given page
 * renders.
 */
function PageBackButton() {
  const goBack = useAppBackNavigation();
  return (
    <button
      type="button"
      onClick={goBack}
      title="Go back"
      aria-label="Go back to the previous page"
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-fg-muted transition hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      <ArrowLeft size={15} strokeWidth={1.75} aria-hidden />
    </button>
  );
}
interface Props { connection: WhatsAppConnectionSnapshot | null; sync: SyncStatusResponse | null; }

const BATTERY_SEGMENTS = 4;

/**
 * A real, current-month AI token allotment gauge in the top bar - reuses
 * the same api.getBilling() entitlement the Billing page's own usage meter
 * reads (max_ai_tokens_per_month). Styled as a 4-segment phone-battery
 * gauge (each segment skewed slightly so the gaps between them read as
 * diagonal cuts) that depletes as tokens are used. Full digit counts, never
 * abbreviated ("125,000 / 500,000", not "125K/500K") - a real countdown
 * should read as real numbers. The count and "Connected as X" sit on the
 * same text line (so they line up at the same level even though the bar
 * above is shrunk to a thin, uniform strip) but stay two distinguishable
 * blocks - a small vertical divider between them, not one merged sentence.
 * Hidden entirely for an unlimited plan (limit === null) - never fakes a
 * gauge for something that isn't actually capped; "Connected as X" still
 * renders alone in that case.
 */
function AiTokenAllowanceBar({ connectionLabel }: { connectionLabel: string }) {
  const [entitlement, setEntitlement] = useState<WorkspaceBillingEntitlement | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const billing = await api.getBilling();
        if (cancelled) return;
        setEntitlement(billing.entitlements.find((e) => e.key === 'max_ai_tokens_per_month') ?? null);
      } catch {
        if (!cancelled) setEntitlement(null);
      }
    }
    void load();
    const timer = setInterval(load, 60_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const hasGauge = Boolean(entitlement && entitlement.isEnabled && entitlement.limit !== null && entitlement.current !== null);
  let remaining = 0;
  let limit = 0;
  let current = 0;
  let percent = 0;
  let tone = 'bg-success';
  if (hasGauge) {
    limit = entitlement!.limit as number;
    current = entitlement!.current as number;
    remaining = Math.max(0, limit - current);
    const remainingRatio = remaining / Math.max(limit, 1);
    percent = Math.min(100, Math.round(remainingRatio * 100));
    tone = remainingRatio <= 0.05 ? 'bg-error' : remainingRatio <= 0.1 ? 'bg-warning' : 'bg-success';
  }

  return (
    <div
      className="mr-1 hidden items-end gap-4 md:flex"
      title={hasGauge ? `${current.toLocaleString()} / ${limit.toLocaleString()} AI tokens used this month` : undefined}
    >
      {hasGauge && (
        <div className="flex translate-x-[3mm] flex-col gap-1">
          {/* No fixed width here on purpose - this column's width is set by
              its widest child (the number below), and the bar row stretches
              to match it (default flex-col cross-axis stretch), so the bar
              is always exactly as long as the number it represents.
              translate-x is a purely visual shift (no reflow), so the
              divider/"Connected as" after it stay exactly where they are. */}
          <div className="flex h-1.5 gap-1">
            {Array.from({ length: BATTERY_SEGMENTS }).map((_, i) => {
              const segStart = (i / BATTERY_SEGMENTS) * 100;
              const segEnd = ((i + 1) / BATTERY_SEGMENTS) * 100;
              const segFill = Math.max(0, Math.min(100, ((percent - segStart) / (segEnd - segStart)) * 100));
              return (
                <div key={i} className="relative flex-1 -skew-x-[12deg] overflow-hidden rounded-[2px] bg-surface-3">
                  <div className={`absolute inset-y-0 left-0 transition-[width] ${tone}`} style={{ width: `${segFill}%` }} />
                </div>
              );
            })}
          </div>
          <span className="whitespace-nowrap text-center tabular-nums text-caption font-medium text-fg-secondary">
            {remaining.toLocaleString()} / {limit.toLocaleString()} left
          </span>
        </div>
      )}
      {hasGauge && <span className="h-3 w-px shrink-0 bg-border-subtle" aria-hidden />}
      <span className="whitespace-nowrap text-caption text-fg-muted">Connected as {connectionLabel}</span>
    </div>
  );
}

export function WorkspaceShell({ connection, sync }: Props) {
  const [searchOpen, setSearchOpen] = useState(false);
  return <div className="flex h-full flex-col bg-surface-0">
    {sync?.syncStatus === 'failed' && <div className="shrink-0 bg-warning/10 px-4 py-1.5 text-center text-caption text-warning">History sync did not fully complete ({sync.lastSyncError ?? 'unknown error'}). Some data may be missing.</div>}
    <CommandPalette open={searchOpen} onOpenChange={setSearchOpen} />
    <div className="flex min-h-0 flex-1"><SaasNavRail /><div className="flex min-w-0 flex-1 flex-col">
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border-subtle bg-surface-1 px-4 py-2"><div className="flex shrink-0 items-center gap-1.5"><PageBackButton /><button type="button" onClick={() => setSearchOpen(true)} aria-label="Open global search" className="flex shrink-0 items-center gap-2 rounded-lg border border-border-subtle bg-surface-2 px-2.5 py-1.5 text-caption text-fg-muted hover:bg-surface-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"><Search size={13} aria-hidden /><span className="hidden sm:inline">Search…</span><kbd className="hidden rounded border border-border-subtle px-1 py-0.5 text-meta sm:inline">⌘K</kbd></button></div><div className="flex min-w-0 flex-1 justify-center"><AlertNotifier /></div><div className="flex shrink-0 items-center gap-3"><AiTokenAllowanceBar connectionLabel={connection?.pushName ?? connection?.phoneNumber ?? connection?.jid ?? '—'} /><NotificationCenter /><span className="rounded-full bg-success/15 px-2 py-0.5 text-meta text-success">Live</span><AccountMenu /></div></header>
      <div className="relative flex min-h-0 flex-1"><Suspense fallback={<RouteFallback />}><Routes>
        <Route path="/" element={<Navigate to="/dashboard" replace />} />
        <Route path="/property" element={<ProductDashboardPage product="property" />} />
        <Route path="/property/operations" element={<PropertyOperationsPage />} />
        <Route path="/food" element={<ProductDashboardPage product="food" />} />
        <Route path="/food/operations" element={<FoodOperationsPage />} />
        <Route path="/retail" element={<ProductDashboardPage product="retail" />} />
        <Route path="/retail/operations" element={<RetailOperationsPage />} />
        <Route path="/beauty" element={<ProductDashboardPage product="beauty" />} />
        <Route path="/beauty/operations" element={<PlaceholderPage title="Beauty & Bookings" description="Appointment calendar, services and client management — coming soon." />} />
        <Route path="/auto" element={<ProductDashboardPage product="auto" />} />
        <Route path="/auto/operations" element={<PlaceholderPage title="Auto Operations" description="Service jobs, vehicle tracking and estimates — coming soon." />} />
        <Route path="/health" element={<ProductDashboardPage product="health" />} />
        <Route path="/health/operations" element={<PlaceholderPage title="Health & Appointments" description="Patient scheduling, records and reminders — coming soon." />} />
        <Route path="/legal" element={<ProductDashboardPage product="legal" />} />
        <Route path="/legal/operations" element={<PlaceholderPage title="Cases & Clients" description="Case management, document requests and consultations — coming soon." />} />
        <Route path="/hospitality" element={<ProductDashboardPage product="hospitality" />} />
        <Route path="/hospitality/operations" element={<PlaceholderPage title="Bookings & Rooms" description="Room reservations, housekeeping and guest services — coming soon." />} />
        <Route path="/construction" element={<ProductDashboardPage product="construction" />} />
        <Route path="/construction/operations" element={<PlaceholderPage title="Projects & Teams" description="Project tracking, subcontractors and materials management — coming soon." />} />
        <Route path="/logistics" element={<ProductDashboardPage product="logistics" />} />
        <Route path="/logistics/operations" element={<PlaceholderPage title="Deliveries & Routes" description="Delivery tracking, route optimisation and driver dispatch — coming soon." />} />
        <Route path="/developer" element={<DeveloperControlPlanePage />} />
        <Route path="/chats" element={<ChatsRoute />} /><Route path="/chats/:chatId" element={<ChatsRoute />} /><Route path="/agents" element={<AgentsPage />} /><Route path="/dashboard" element={<DashboardRoute />} /><Route path="/trends" element={<TrendsRoute />} /><Route path="/lists" element={<ListsRoute />} /><Route path="/crm" element={<CrmRoute />} /><Route path="/property-operations" element={<PropertyOperationsPage />} /><Route path="/retail-operations" element={<RetailOperationsPage />} /><Route path="/invoices" element={<InvoicesPage />} /><Route path="/activity-log" element={<ActivityLogPage />} /><Route path="/approvals" element={<ApprovalsPage />} /><Route path="/appointments" element={<AppointmentsPage />} /><Route path="/integrations" element={<IntegrationHealthPage />} /><Route path="/automations" element={<FunnelsRoute />} /><Route path="/marketing" element={<MarketingRoute />} /><Route path="/email" element={<EmailRoute />} /><Route path="/billing" element={<BillingRoute />} /><Route path="/billing/plans/:planKey" element={<PlanCheckoutRoute />} /><Route path="/settings" element={<SettingsRoute connection={connection} />} /><Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes></Suspense></div>
    </div></div><SaasNavBottomBar />
  </div>;
}
