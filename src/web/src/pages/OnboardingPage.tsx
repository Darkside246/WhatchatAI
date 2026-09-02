import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Loader2, RefreshCw, ShieldCheck, Smartphone, AlertTriangle, Check, Eye, QrCode, Phone } from 'lucide-react';
import { api, ApiError, type WhatsAppConnectionSnapshot } from '../lib/api.js';

interface Props {
  connection: WhatsAppConnectionSnapshot | null;
  /** True once several consecutive status polls have failed - see useAppGate's own doc comment. Whatever QR is still on screen is stale, not necessarily invalid; the backend just isn't answering right now. */
  serverUnreachable?: boolean;
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
  PAIRING_CODE_READY: { title: 'Enter this code', detail: 'Open WhatsApp on the phone that owns this number.' },
  CONNECTED: { title: 'Linked', detail: 'Your WhatsApp account is connected.' },
  RECONNECTING: { title: 'Reconnecting', detail: 'The link dropped. Trying to restore it…' },
  LOGGED_OUT: { title: 'Session ended', detail: 'This device was unlinked. Generate a new code to link again.' },
  CONFLICT_REPLACED: {
    title: 'Connected elsewhere',
    detail: 'This WhatsApp account is already connected from another location or device. Disconnect it there first, then try linking again here.',
  },
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

function QrPanel({
  connection,
  serverUnreachable,
  onRetry,
  retrying,
}: {
  connection: WhatsAppConnectionSnapshot | null;
  serverUnreachable: boolean;
  onRetry: () => void;
  retrying: boolean;
}) {
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

  const failed = status === 'ERROR' || status === 'LOGGED_OUT' || status === 'CONFLICT_REPLACED';
  const ago = refreshedAgo(connection?.qrGeneratedAt ?? null, now);

  return (
    <div className="w-full max-w-sm rounded-2xl border border-border-subtle bg-surface-1 p-6 shadow-xl sm:p-8">
      {/*
        Pure white only when a real code is present - QR scanning needs that
        contrast. With no code, white-on-white reads as a broken empty box,
        so the placeholder gets its own tinted, dashed surface instead.
      */}
      <div
        className={`relative mx-auto flex aspect-square w-full max-w-[17rem] items-center justify-center rounded-xl p-3 ${
          qrDataUrl ? 'bg-white' : 'border border-dashed border-border-subtle bg-surface-2'
        }`}
      >
        {qrDataUrl ? (
          <img
            src={qrDataUrl}
            alt="WhatsApp pairing QR code"
            className={`h-full w-full object-contain transition-opacity ${serverUnreachable ? 'opacity-30' : ''}`}
          />
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
        {/*
          A stale QR left frozen on screen with no explanation used to look
          exactly like "this code is broken" - the code itself was often
          genuinely fine, the backend was just unreachable (a crash, a
          restart, a network blip) and had stopped rotating it. This makes
          that honest instead of silent.
        */}
        {qrDataUrl && serverUnreachable && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 rounded-xl bg-surface-1/80">
            <Loader2 size={22} className="animate-spin text-fg-muted" aria-hidden />
            <span className="max-w-[80%] text-center text-caption font-medium text-fg-secondary">Reconnecting to the server…</span>
          </div>
        )}
      </div>

      <div className="mt-5 text-center">
        <p className="text-body font-semibold text-fg">{serverUnreachable ? 'Reconnecting…' : copy.title}</p>
        <p className="mt-1 text-caption text-fg-secondary">
          {serverUnreachable ? 'Lost contact with the server - this code will resume rotating once it\'s back.' : copy.detail}
        </p>

        {status === 'QR_READY' && ago && !serverUnreachable && (
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

/**
 * WhatsApp Web's own second linking method - enter a phone number, type
 * the resulting code into WhatsApp instead of scanning. Baileys never
 * auto-rotates this code the way it rotates a QR, so there's no
 * "generate a new code" gate behind a failure state here - the button is
 * always available, matching how the code can go silently stale with no
 * status change telling the UI.
 */
function PhonePairingPanel({
  connection,
  onSubmit,
  submitting,
  submitError,
}: {
  connection: WhatsAppConnectionSnapshot | null;
  onSubmit: (phoneNumber: string) => void;
  submitting: boolean;
  submitError: string | null;
}) {
  const [phoneNumber, setPhoneNumber] = useState('');
  const status: Status = connection?.status ?? 'CONNECTING';
  const pairingCode = connection?.pairingCode ?? null;
  const copy = STATUS_COPY[status];

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const ago = refreshedAgo(connection?.pairingCodeGeneratedAt ?? null, now);

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!phoneNumber.trim() || submitting) return;
    onSubmit(phoneNumber.trim());
  }

  return (
    <div className="w-full max-w-sm rounded-2xl border border-border-subtle bg-surface-1 p-6 shadow-xl sm:p-8">
      {!pairingCode ? (
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-body text-fg-secondary">
            Phone number
            <input
              type="tel"
              required
              autoFocus
              placeholder="+1 415 555 2671"
              value={phoneNumber}
              onChange={(event) => setPhoneNumber(event.target.value)}
              className="rounded-lg border border-border-subtle bg-surface-1 px-3 py-2 text-body text-fg outline-none focus:border-accent"
            />
          </label>
          <p className="text-meta text-fg-muted">Include your country code - this is the number WhatsApp is already linked to on your phone.</p>
          {submitError && <p className="text-caption text-error">{submitError}</p>}
          <button
            type="submit"
            disabled={submitting}
            className="control-lg mt-2 w-full justify-center bg-accent font-medium text-white hover:bg-accent-dim disabled:opacity-50"
          >
            {submitting ? <Loader2 size={15} className="animate-spin" aria-hidden /> : <Phone size={15} aria-hidden />}
            {submitting ? 'Requesting a code…' : 'Get a pairing code'}
          </button>
        </form>
      ) : (
        <div className="text-center">
          <p className="font-mono text-display font-semibold tracking-[0.15em] text-fg">
            {pairingCode.slice(0, 4)}-{pairingCode.slice(4)}
          </p>
          <p className="mt-3 text-body font-semibold text-fg">{copy.title}</p>
          <p className="mt-1 text-caption text-fg-secondary">Enter this code in WhatsApp on {connection?.pairingPhoneNumber ?? 'your phone'}.</p>
          {ago && (
            <p className="mt-2 flex items-center justify-center gap-1.5 text-meta text-fg-muted">
              <RefreshCw size={11} aria-hidden />
              Code {ago} — request a new one if it stops working.
            </p>
          )}
          {submitError && <p className="mt-2 text-caption text-error">{submitError}</p>}
          <button
            type="button"
            onClick={() => onSubmit(connection?.pairingPhoneNumber ?? phoneNumber)}
            disabled={submitting}
            className="control-lg mt-5 w-full justify-center bg-accent font-medium text-white hover:bg-accent-dim disabled:opacity-50"
          >
            {submitting ? <Loader2 size={15} className="animate-spin" aria-hidden /> : <RefreshCw size={15} aria-hidden />}
            {submitting ? 'Requesting…' : 'Request a new code'}
          </button>
        </div>
      )}

      <ol className="mt-6 space-y-3 border-t border-border-subtle pt-5">
        {[
          'Open WhatsApp on your phone.',
          'Tap Settings, then Linked devices.',
          'Tap Link a device, then Link with phone number instead.',
          'Enter the code shown here.',
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

/** Real evidence a phone-pairing attempt is already under way for this business - a code was issued, or the backend is actively requesting one. Used so a remount (e.g. useAppGate briefly routing back through 'onboarding' during the real post-pairing reconnect) never silently resets an in-progress phone pairing back to the QR tab underneath the user. */
function hasInProgressPhonePairing(connection: WhatsAppConnectionSnapshot | null): boolean {
  return Boolean(connection?.pairingPhoneNumber) || connection?.status === 'PAIRING_CODE_READY';
}

export function OnboardingPage({ connection, serverUnreachable = false }: Props) {
  const triggered = useRef(false);
  const [retrying, setRetrying] = useState(false);
  const [pairMethod, setPairMethod] = useState<'qr' | 'phone'>(() => (hasInProgressPhonePairing(connection) ? 'phone' : 'qr'));
  const [phoneSubmitting, setPhoneSubmitting] = useState(false);
  const [phoneSubmitError, setPhoneSubmitError] = useState<string | null>(null);
  const [switchingMethod, setSwitchingMethod] = useState(false);

  useEffect(() => {
    if (!connection) return;
    if (pairMethod !== 'qr') return;
    if (hasInProgressPhonePairing(connection)) return;
    if ((connection.status === 'DISCONNECTED' || connection.status === 'LOGGED_OUT') && !triggered.current) {
      triggered.current = true;
      api.connectWhatsApp().catch(() => {
        triggered.current = false;
      });
    }
    if (connection.status === 'QR_READY' || connection.status === 'CONNECTING') {
      triggered.current = true;
    }
  }, [connection, pairMethod]);

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

  async function handleRequestPairingCode(phoneNumber: string) {
    setPhoneSubmitting(true);
    setPhoneSubmitError(null);
    try {
      await api.pairWhatsAppByPhone(phoneNumber);
    } catch (err) {
      setPhoneSubmitError(err instanceof ApiError ? err.message : 'Could not request a pairing code. Check the number and try again.');
    } finally {
      setPhoneSubmitting(false);
    }
  }

  /**
   * Switching tabs never happens silently against a live phone-pairing
   * socket: requestPhonePairingCode() tears down a stale QR socket for you
   * (see the backend), but going the other direction needs an explicit
   * disconnect+reconnect from here so a chosen-but-unentered phone code
   * doesn't linger while a fresh QR is generated underneath it.
   */
  async function handleSwitchMethod(method: 'qr' | 'phone') {
    if (method === 'qr' && pairMethod !== 'qr' && (connection?.status === 'PAIRING_CODE_READY' || connection?.pairingCode)) {
      setSwitchingMethod(true);
      try {
        await api.disconnectWhatsApp();
        triggered.current = false;
        await api.connectWhatsApp();
      } finally {
        setSwitchingMethod(false);
      }
    }
    setPhoneSubmitError(null);
    setPairMethod(method);
  }

  return (
    <div className="flex min-h-full flex-col bg-surface-0 lg:flex-row">
      <section className="order-2 flex flex-1 flex-col justify-center gap-6 px-6 py-10 sm:px-10 lg:order-1 lg:px-16">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-body-lg font-bold text-accent">
            A
          </div>
          <span className="text-title font-semibold tracking-tight text-fg">AURA</span>
        </div>

        <h1 className="max-w-md text-display font-semibold leading-tight tracking-tight text-fg sm:text-[2rem]">
          Turn your WhatsApp into a real business operating system.
        </h1>

        <p className="max-w-md text-body leading-relaxed text-fg-secondary">
          Connect your existing WhatsApp number once. AURA keeps every real conversation, contact and message in
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
          Said plainly, before anyone links anything. AURA joins as a
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
                AURA joins as a linked device, the same way WhatsApp Web does. Your phone stays the main device.
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

      <section className="order-1 flex flex-1 flex-col items-center justify-center gap-4 border-b border-border-subtle bg-surface-2 px-6 py-10 sm:px-10 lg:order-2 lg:border-b-0 lg:border-l">
        <div className="flex w-full max-w-sm rounded-lg border border-border-subtle bg-surface-1 p-1">
          <button
            type="button"
            onClick={() => void handleSwitchMethod('qr')}
            disabled={switchingMethod}
            className={`flex flex-1 items-center justify-center gap-1.5 rounded-md py-1.5 text-caption font-medium transition disabled:opacity-50 ${
              pairMethod === 'qr' ? 'bg-accent text-white' : 'text-fg-secondary hover:bg-surface-2'
            }`}
          >
            <QrCode size={13} aria-hidden />
            Scan a QR code
          </button>
          <button
            type="button"
            onClick={() => void handleSwitchMethod('phone')}
            disabled={switchingMethod}
            className={`flex flex-1 items-center justify-center gap-1.5 rounded-md py-1.5 text-caption font-medium transition disabled:opacity-50 ${
              pairMethod === 'phone' ? 'bg-accent text-white' : 'text-fg-secondary hover:bg-surface-2'
            }`}
          >
            <Phone size={13} aria-hidden />
            Enter a phone number
          </button>
        </div>

        {pairMethod === 'qr' ? (
          <QrPanel connection={connection} serverUnreachable={serverUnreachable} onRetry={() => void handleRetry()} retrying={retrying} />
        ) : (
          <PhonePairingPanel
            connection={connection}
            onSubmit={(phone) => void handleRequestPairingCode(phone)}
            submitting={phoneSubmitting}
            submitError={phoneSubmitError}
          />
        )}
      </section>
    </div>
  );
}
