import { useEffect, useRef, useState } from 'react';
import { ShieldCheck, Smartphone, Check, Eye, QrCode, Phone, RefreshCw } from 'lucide-react';
import { api, ApiError, type WhatsAppConnectionSnapshot } from '../lib/api.js';
import { QrPanel, PhonePairingPanel } from '../components/WhatsAppPairingPanels.js';

interface Props {
  connection: WhatsAppConnectionSnapshot | null;
  /** True once several consecutive status polls have failed - see useAppGate's own doc comment. Whatever QR is still on screen is stale, not necessarily invalid; the backend just isn't answering right now. */
  serverUnreachable?: boolean;
}

/** Real evidence a phone-pairing attempt is already under way for this business - a code was issued, or the backend is actively requesting one. Used so a remount (e.g. useAppGate briefly routing back through 'onboarding' during the real post-pairing reconnect) never silently resets an in-progress phone pairing back to the QR tab underneath the user. */
function hasInProgressPhonePairing(connection: WhatsAppConnectionSnapshot | null): boolean {
  return Boolean(connection?.pairingPhoneNumber) || connection?.status === 'PAIRING_CODE_READY';
}

/**
 * The connection-snapshot check above is not enough on its own: it only
 * sees evidence of an in-progress phone pairing once the backend's
 * response has actually landed in a poll. A remount that happens to land
 * in the gap between "user submitted a phone number" and "the next poll
 * reflects the resulting pairing code" - a real, observed race, not
 * theoretical: the exact "code was on screen for one second" bug reported
 * while testing - sees a null/stale connection and has no way to know the
 * user was ever on the phone tab at all. sessionStorage survives a full
 * component unmount/remount within the same tab, unlike React state or a
 * ref, so it is the one signal that cannot be lost to that race. Scoped to
 * sessionStorage (not localStorage) deliberately - this is a
 * this-onboarding-attempt-only preference, not something that should
 * outlive the tab or follow the user to a later, unrelated signup.
 */
const PAIR_METHOD_STORAGE_KEY = 'aura:onboarding:pairMethod';

function readStoredPairMethod(): 'qr' | 'phone' | null {
  try {
    const value = sessionStorage.getItem(PAIR_METHOD_STORAGE_KEY);
    return value === 'phone' ? 'phone' : null;
  } catch {
    return null;
  }
}

function writeStoredPairMethod(method: 'qr' | 'phone'): void {
  try {
    if (method === 'phone') sessionStorage.setItem(PAIR_METHOD_STORAGE_KEY, 'phone');
    else sessionStorage.removeItem(PAIR_METHOD_STORAGE_KEY);
  } catch {
    // Storage can throw (private browsing, quota) - the connection-snapshot
    // check above still applies as a fallback, so this is not fatal.
  }
}

export function OnboardingPage({ connection, serverUnreachable = false }: Props) {
  const triggered = useRef(false);
  const [retrying, setRetrying] = useState(false);
  const [pairMethod, setPairMethod] = useState<'qr' | 'phone'>(
    () => (readStoredPairMethod() === 'phone' || hasInProgressPhonePairing(connection) ? 'phone' : 'qr'),
  );
  const [phoneSubmitting, setPhoneSubmitting] = useState(false);
  const [phoneSubmitError, setPhoneSubmitError] = useState<string | null>(null);
  const [switchingMethod, setSwitchingMethod] = useState(false);

  useEffect(() => {
    if (!connection) return;
    if (pairMethod !== 'qr') return;
    if (readStoredPairMethod() === 'phone') return;
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
    writeStoredPairMethod(method);
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
