import { useEffect, useRef, useState } from 'react';
import { Loader2, RefreshCw, ShieldCheck, Smartphone, AlertTriangle, Check, Eye } from 'lucide-react';
import { api, type WhatsAppConnectionSnapshot } from '../lib/api.js';

interface Props {
  connection: WhatsAppConnectionSnapshot | null;
}

type Status = WhatsAppConnectionSnapshot['status'];

/**
 * One honest line per real connection state. Every one of these is a state
 * the service genuinely reports - there is no "almost there" or invented
 * progress step, because linking either has a live code, is negotiating, or
 * has failed.
 */
const STATUS_COPY: Record<Status, { title: string; detail: string }> = {
  DISCONNECTED: { title: 'Starting up', detail: 'Asking WhatsApp for a pairing code…' },
  CONNECTING: { title: 'Starting up', detail: 'Asking WhatsApp for a pairing code…' },
  QR_READY: { title: 'Scan to link', detail: 'Open WhatsApp on the phone that owns this number.' },
  CONNECTED: { title: 'Linked', detail: 'Your WhatsApp account is connected.' },
  RECONNECTING: { title: 'Reconnecting', detail: 'The link dropped. Trying to restore it…' },
  LOGGED_OUT: { title: 'Session ended', detail: 'This device was unlinked. Generate a new code to link again.' },
  ERROR: { title: 'Could not get a code', detail: 'WhatsApp did not return a pairing code.' },
};

/** Real relative time from the real emission timestamp - never a fabricated countdown. */
function refreshedAgo(iso: string | null, now: number): string | null {
  if (!iso) return null;
  const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (seconds < 5) return 'refreshed just now';
  if (seconds < 60) return `refreshed ${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  return `refreshed ${minutes}m ago`;
}

function QrPanel({ connection, onRetry, retrying }: { connection: WhatsAppConnectionSnapshot | null; onRetry: () => void; retrying: boolean }) {
  const status: Status = connection?.status ?? 'CONNECTING';
  const qrDataUrl = connection?.qrDataUrl ?? null;
  const copy = STATUS_COPY[status];

  // Ticks only so the "refreshed Ns ago" line stays truthful while the same
  // code is on screen.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const failed = status === 'ERROR' || status === 'LOGGED_OUT';
  const ago = refreshedAgo(connection?.qrGeneratedAt ?? null, now);

  return (
    <div className="w-full max-w-sm rounded-2xl border border-border-subtle bg-surface-1 p-6 shadow-xl sm:p-8">
      {/*
        Pure white only when a real code is present - QR scanning needs that
        contrast. With no code, white-on-white reads as a broken empty box,
        so the placeholder gets its own tinted, dashed surface instead.
      */}
      <div
        className={`mx-auto flex aspect-square w-full max-w-[17rem] items-center justify-center rounded-xl p-3 ${
          qrDataUrl ? 'bg-white' : 'border border-dashed border-border-subtle bg-surface-2'
        }`}
      >
        {qrDataUrl ? (
          <img src={qrDataUrl} alt="WhatsApp pairing QR code" className="h-full w-full object-contain" />
        ) : (
          <div className="flex flex-col items-center justify-center gap-3 text-fg-muted">
            {failed ? (
              <AlertTriangle size={26} className="text-warning" aria-hidden />
            ) : (
              <Loader2 size={26} className="animate-spin" aria-hidden />
            )}
            <span className="text-caption">{failed ? 'No code' : 'Generating code'}</span>
          </div>
        )}
      </div>

      <div className="mt-5 text-center">
        <p className="text-body font-semibold text-fg">{copy.title}</p>
        <p className="mt-1 text-caption text-fg-secondary">{copy.detail}</p>

        {status === 'QR_READY' && ago && (
          <p className="mt-2 flex items-center justify-center gap-1.5 text-meta text-fg-muted">
            <RefreshCw size={11} aria-hidden />
            This code {ago} — it rotates on its own, no need to reload.
          </p>
        )}

        {status === 'RECONNECTING' && (connection?.reconnectAttempt ?? 0) > 0 && (
          <p className="mt-2 text-meta text-fg-muted">Attempt {connection?.reconnectAttempt}.</p>
        )}

        {connection?.lastError && failed && (
          <p className="mt-2 break-words text-meta text-error">{connection.lastError}</p>
        )}
      </div>

      {failed && (
        <button
          type="button"
          onClick={onRetry}
          disabled={retrying}
          className="control-lg mt-5 w-full justify-center bg-accent font-medium text-white hover:bg-accent-dim disabled:opacity-50"
        >
          {retrying ? <Loader2 size={15} className="animate-spin" aria-hidden /> : <RefreshCw size={15} aria-hidden />}
          {retrying ? 'Requesting…' : 'Generate a new code'}
        </button>
      )}

      <ol className="mt-6 space-y-3 border-t border-border-subtle pt-5">
        {[
          'Open WhatsApp on your phone.',
          'Tap Settings, then Linked devices.',
          'Tap Link a device, then point your camera here.',
        ].map((step, index) => (
          <li key={step} className="flex gap-3 text-caption text-fg-secondary">
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-surface-3 text-meta font-semibold text-fg-secondary">
              {index + 1}
            </span>
            <span className="min-w-0-safe">{step}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

export function OnboardingPage({ connection }: Props) {
  const triggered = useRef(false);
  const [retrying, setRetrying] = useState(false);

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

  async function handleRetry() {
    setRetrying(true);
    try {
      await api.connectWhatsApp();
    } catch {
      triggered.current = false;
    } finally {
      setRetrying(false);
    }
  }

  return (
    <div className="flex min-h-full flex-col bg-surface-0 lg:flex-row">
      <section className="order-2 flex flex-1 flex-col justify-center gap-6 px-6 py-10 sm:px-10 lg:order-1 lg:px-16">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-body-lg font-bold text-accent">
            W
          </div>
          <span className="text-title font-semibold tracking-tight text-fg">WhatchatAI</span>
        </div>

        <h1 className="max-w-md text-display font-semibold leading-tight tracking-tight text-fg sm:text-[2rem]">
          Turn your WhatsApp into a real business operating system.
        </h1>

        <p className="max-w-md text-body leading-relaxed text-fg-secondary">
          Connect your existing WhatsApp number once. WhatchatAI keeps every real conversation, contact and message in
          sync, and gives your team AI agents, a CRM and automation built directly around it — no separate inbox, no
          manual exports.
        </p>

        <ul className="max-w-md space-y-3">
          {[
            'One real WhatsApp connection, fully synced — chats, contacts, groups, history.',
            'AI agents that can respond, with human takeover always one click away.',
            'CRM, leads and analytics built around the conversations you already have.',
          ].map((point) => (
            <li key={point} className="flex gap-3 text-body text-fg-secondary">
              <Check size={15} className="mt-0.5 shrink-0 text-accent" aria-hidden />
              <span className="min-w-0-safe">{point}</span>
            </li>
          ))}
        </ul>

        {/*
          Said plainly, before anyone links anything. WhatchatAI joins as a
          WhatsApp linked device, exactly like WhatsApp Web - which means
          messages arrive here already decrypted and your team can read them.
          Claiming "nobody but you can read this" on this screen would be a
          lie, and this is the moment the user is deciding to trust us.
        */}
        <div className="max-w-md rounded-xl border border-border-subtle bg-surface-1 p-4">
          <p className="flex items-center gap-2 text-caption font-semibold text-fg">
            <ShieldCheck size={14} className="shrink-0 text-accent" aria-hidden />
            What linking actually does
          </p>
          <ul className="mt-2 space-y-1.5 text-meta leading-relaxed text-fg-secondary">
            <li className="flex gap-2">
              <Smartphone size={12} className="mt-0.5 shrink-0 text-fg-muted" aria-hidden />
              <span className="min-w-0-safe">
                WhatchatAI joins as a linked device, the same way WhatsApp Web does. Your phone stays the main device.
              </span>
            </li>
            <li className="flex gap-2">
              <Eye size={12} className="mt-0.5 shrink-0 text-fg-muted" aria-hidden />
              <span className="min-w-0-safe">
                Messages arrive here already decrypted, so your team — and the AI agents you switch on — can read them.
                Message text is encrypted again before it is stored.
              </span>
            </li>
            <li className="flex gap-2">
              <RefreshCw size={12} className="mt-0.5 shrink-0 text-fg-muted" aria-hidden />
              <span className="min-w-0-safe">
                You can unlink at any time from WhatsApp → Linked devices, and the connection stops immediately.
              </span>
            </li>
          </ul>
        </div>
      </section>

      <section className="order-1 flex flex-1 items-center justify-center border-b border-border-subtle bg-surface-2 px-6 py-10 sm:px-10 lg:order-2 lg:border-b-0 lg:border-l">
        <QrPanel connection={connection} onRetry={() => void handleRetry()} retrying={retrying} />
      </section>
    </div>
  );
}
