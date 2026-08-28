import { lazy, Suspense, useState } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { Search } from 'lucide-react';
import type { SyncStatusResponse, WhatsAppConnectionSnapshot } from '../lib/api.js';
import { SaasNavRail, SaasNavBottomBar } from '../components/SaasNavRail.js';
import { NotificationCenter } from '../components/NotificationCenter.js';
import { CommandPalette } from '../components/CommandPalette.js';
const ChatsRoute = lazy(() => import('./ChatsRoute.js').then((m) => ({ default: m.ChatsRoute })));
const AgentsPage = lazy(() => import('./AgentsPage.js').then((m) => ({ default: m.AgentsPage })));
const CrmRoute = lazy(() => import('./CrmRoute.js').then((m) => ({ default: m.CrmRoute })));
const BillingRoute = lazy(() => import('./BillingRoute.js').then((m) => ({ default: m.BillingRoute })));
const SettingsRoute = lazy(() => import('./SettingsRoute.js').then((m) => ({ default: m.SettingsRoute })));
const DashboardRoute = lazy(() => import('./DashboardRoute.js').then((m) => ({ default: m.DashboardRoute })));
const MarketingRoute = lazy(() => import('./MarketingRoute.js').then((m) => ({ default: m.MarketingRoute })));
const EmailRoute = lazy(() => import('./EmailRoute.js').then((m) => ({ default: m.EmailRoute })));
const FunnelsRoute = lazy(() => import('./FunnelsRoute.js').then((m) => ({ default: m.FunnelsRoute })));
const PropertyOperationsPage = lazy(() => import('./PropertyOperationsPage.js').then((m) => ({ default: m.PropertyOperationsPage })));
const ProductDashboardPage = lazy(() => import('./ProductDashboardPage.js').then((m) => ({ default: m.ProductDashboardPage })));
const FoodOperationsPage = lazy(() => import('./FoodOperationsPage.js').then((m) => ({ default: m.FoodOperationsPage })));
const DeveloperControlPlanePage = lazy(() => import('./DeveloperControlPlanePage.js').then((m) => ({ default: m.DeveloperControlPlanePage })));
const InvoicesPage = lazy(() => import('./InvoicesPage.js').then((m) => ({ default: m.InvoicesPage })));

function RouteFallback() { return <div className="flex h-full flex-1 items-center justify-center text-caption text-fg-muted">Loading…</div>; }
interface Props { connection: WhatsAppConnectionSnapshot | null; sync: SyncStatusResponse | null; }

export function WorkspaceShell({ connection, sync }: Props) {
  const [searchOpen, setSearchOpen] = useState(false);
  return <div className="flex h-full flex-col bg-surface-0">
    {sync?.syncStatus === 'failed' && <div className="shrink-0 bg-warning/10 px-4 py-1.5 text-center text-caption text-warning">History sync did not fully complete ({sync.lastSyncError ?? 'unknown error'}). Some data may be missing.</div>}
    <CommandPalette open={searchOpen} onOpenChange={setSearchOpen} />
    <div className="flex min-h-0 flex-1"><SaasNavRail /><div className="flex min-w-0 flex-1 flex-col">
      <header className="flex shrink-0 items-center justify-between border-b border-border-subtle bg-surface-1 px-4 py-2"><button type="button" onClick={() => setSearchOpen(true)} aria-label="Open global search" className="flex items-center gap-2 rounded-lg border border-border-subtle bg-surface-2 px-2.5 py-1.5 text-caption text-fg-muted hover:bg-surface-3"><Search size={13} aria-hidden /><span className="hidden sm:inline">Search…</span><kbd className="hidden rounded border border-border-subtle px-1 py-0.5 text-meta sm:inline">⌘K</kbd></button><div className="flex items-center gap-3"><p className="hidden text-caption text-fg-muted md:block">Connected as {connection?.pushName ?? connection?.phoneNumber ?? connection?.jid ?? '—'}</p><NotificationCenter /><span className="rounded-full bg-success/15 px-2 py-0.5 text-meta text-success">Live</span></div></header>
      <div className="flex min-h-0 flex-1"><Suspense fallback={<RouteFallback />}><Routes>
        <Route path="/" element={<Navigate to="/dashboard" replace />} />
        <Route path="/property" element={<ProductDashboardPage product="property" />} />
        <Route path="/property/operations" element={<PropertyOperationsPage />} />
        <Route path="/food" element={<ProductDashboardPage product="food" />} />
        <Route path="/food/operations" element={<FoodOperationsPage />} />
        <Route path="/developer" element={<DeveloperControlPlanePage />} />
        <Route path="/chats" element={<ChatsRoute />} /><Route path="/chats/:chatId" element={<ChatsRoute />} /><Route path="/agents" element={<AgentsPage />} /><Route path="/dashboard" element={<DashboardRoute />} /><Route path="/crm" element={<CrmRoute />} /><Route path="/property-operations" element={<PropertyOperationsPage />} /><Route path="/invoices" element={<InvoicesPage />} /><Route path="/automations" element={<FunnelsRoute />} /><Route path="/marketing" element={<MarketingRoute />} /><Route path="/email" element={<EmailRoute />} /><Route path="/billing" element={<BillingRoute />} /><Route path="/settings" element={<SettingsRoute connection={connection} />} /><Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes></Suspense></div>
    </div></div><SaasNavBottomBar />
  </div>;
}
