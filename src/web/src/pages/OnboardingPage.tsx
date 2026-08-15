import { useEffect, useRef } from 'react';
import { api, type WhatsAppConnectionSnapshot } from '../lib/api.js';

interface Props {
  connection: WhatsAppConnectionSnapshot | null;
}

const STATUS_COPY: Record<string, string> = {
  DISCONNECTED: 'Preparing your connection…',
  CONNECTING: 'Preparing your connection…',
  QR_READY: 'Scan this code with WhatsApp on your phone',
  RECONNECTING: 'Reconnecting…',
  LOGGED_OUT: 'Session ended. Generating a new code…',
  ERROR: 'Something went wrong generating the code.',
};

export function OnboardingPage({ connection }: Props) {
  const triggered = useRef(false);

  useEffect(() => {
    if (!connection) return;
    if ((connection.status === 'DISCONNECTED' || connection.status === 'LOGGED_OUT') && !triggered.current) {
      triggered.current = true;
      api.connectWhatsApp().catch(() => {
        triggered.current = false;
      });
    }
    if (connection.status === 'QR_READY' || connection.status === 'CONNECTING') {
      triggered.current = true;
    }
  }, [connection]);

  const status = connection?.status ?? 'CONNECTING';
  const qrDataUrl = connection?.qrDataUrl ?? null;

  return (
    <div className="flex min-h-full flex-col lg:flex-row bg-surface-0">
      <section className="order-2 flex flex-1 flex-col justify-center gap-6 px-6 py-10 sm:px-12 lg:order-1 lg:px-16">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-500/15 text-lg font-bold text-emerald-400">
            W
          </div>
          <span className="text-lg font-semibold tracking-tight text-white">WhatchatAI</span>
        </div>

        <h1 className="max-w-md text-3xl font-semibold leading-tight text-white sm:text-4xl">
          Turn your WhatsApp into a real business operating system.
        </h1>
        <p className="max-w-md text-base leading-relaxed text-gray-400">
          Connect your existing WhatsApp number once. WhatchatAI keeps every real conversation, contact, and
          message in sync, and gives your team AI agents, a CRM, and automation built directly around it — no
          separate inbox, no manual exports.
        </p>

        <ul className="max-w-md space-y-3 text-sm text-gray-400">
          <li className="flex gap-3">
            <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400" />
            One real WhatsApp connection, fully synced — chats, contacts, groups, history.
          </li>
          <li className="flex gap-3">
            <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400" />
            AI agents that can respond, with human takeover always one click away.
          </li>
          <li className="flex gap-3">
            <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400" />
            CRM, leads, and analytics built around the conversations you already have.
          </li>
        </ul>
      </section>

      <section className="order-1 flex flex-1 flex-col items-center justify-center gap-6 border-b border-border-subtle bg-surface-1 px-6 py-10 sm:px-12 lg:order-2 lg:border-b-0 lg:border-l">
        <div className="flex w-full max-w-sm flex-col items-center gap-6 rounded-2xl border border-border-subtle bg-surface-2 p-8 text-center shadow-2xl shadow-black/40">
          <div className="flex h-64 w-64 items-center justify-center rounded-xl bg-white p-3">
            {qrDataUrl ? (
              <img src={qrDataUrl} alt="WhatsApp QR code" className="h-full w-full object-contain" />
            ) : (
              <div className="flex h-full w-full flex-col items-center justify-center gap-3 text-gray-500">
                <div className="h-8 w-8 animate-spin rounded-full border-2 border-gray-300 border-t-transparent" />
                <span className="text-xs">{status === 'ERROR' ? 'Failed' : 'Generating code'}</span>
              </div>
            )}
          </div>

          <div>
            <p className="text-sm font-medium text-white">{STATUS_COPY[status] ?? status}</p>
            {connection?.lastError && status === 'ERROR' && (
              <p className="mt-1 text-xs text-red-400">{connection.lastError}</p>
            )}
          </div>

          <ol className="w-full space-y-2 text-left text-xs text-gray-400">
            <li>1. Open WhatsApp on your phone.</li>
            <li>2. Go to Settings → Linked Devices → Link a Device.</li>
            <li>3. Point your phone at this screen.</li>
          </ol>
        </div>
      </section>
    </div>
  );
}
