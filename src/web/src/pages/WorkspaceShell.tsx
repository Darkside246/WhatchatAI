import { Navigate, Route, Routes } from 'react-router-dom';
import type { SyncStatusResponse, WhatsAppConnectionSnapshot } from '../lib/api.js';
import { SaasNavRail, SaasNavBottomBar } from '../components/SaasNavRail.js';
import { ChatsRoute } from './ChatsRoute.js';
import { AgentsPage } from './AgentsPage.js';
import { CrmRoute } from './CrmRoute.js';
import { BillingRoute } from './BillingRoute.js';
import { SettingsRoute } from './SettingsRoute.js';
import { PlaceholderPage } from './PlaceholderPage.js';

interface Props {
  connection: WhatsAppConnectionSnapshot | null;
  sync: SyncStatusResponse | null;
}

export function WorkspaceShell({ connection, sync }: Props) {
  return (
    <div className="flex h-full flex-col bg-surface-0">
      {sync?.syncStatus === 'failed' && (
        <div className="shrink-0 bg-warning/10 px-4 py-1.5 text-center text-xs text-warning">
          History sync did not fully complete ({sync.lastSyncError ?? 'unknown error'}). Some data may be missing.
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <SaasNavRail />

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="hidden shrink-0 items-center justify-between border-b border-border-subtle bg-surface-1 px-4 py-2 lg:flex">
            <p className="text-xs text-fg-muted">
              Connected as {connection?.pushName ?? connection?.phoneNumber ?? connection?.jid ?? '—'}
            </p>
            <span className="rounded-full bg-success/15 px-2 py-0.5 text-[11px] text-success">Live</span>
          </header>

          <div className="flex min-h-0 flex-1">
            <Routes>
              <Route path="/" element={<Navigate to="/chats" replace />} />
              <Route path="/chats" element={<ChatsRoute />} />
              <Route path="/chats/:chatId" element={<ChatsRoute />} />
              <Route path="/agents" element={<AgentsPage />} />
              <Route
                path="/dashboard"
                element={
                  <PlaceholderPage
                    title="Dashboard"
                    description="Business-wide metrics from real data will live here once analytics is built."
                  />
                }
              />
              <Route path="/crm" element={<CrmRoute />} />
              <Route
                path="/automations"
                element={<PlaceholderPage title="Automations" description="The no-code automation builder is not built yet." />}
              />
              <Route
                path="/marketing"
                element={<PlaceholderPage title="Marketing" description="Campaigns and broadcast tools are not built yet." />}
              />
              <Route path="/billing" element={<BillingRoute />} />
              <Route path="/settings" element={<SettingsRoute connection={connection} />} />
              <Route path="*" element={<Navigate to="/chats" replace />} />
            </Routes>
          </div>
        </div>
      </div>

      <SaasNavBottomBar />
    </div>
  );
}
