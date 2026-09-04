import { useEffect, useState, type FormEvent } from 'react';
import { Loader2, RefreshCw, AlertTriangle, Phone } from 'lucide-react';
import { getCountries, getCountryCallingCode, type CountryCode } from 'libphonenumber-js/min';
import type { WhatsAppConnectionSnapshot } from '../lib/api.js';

/**
 * The real QR and phone-pairing UI, extracted from OnboardingPage.tsx so it
 * can be reused for a "Change number" flow (Settings) without duplicating
 * this already-hard-won pairing logic - country selector, urgency
 * countdown, and stale-socket-guard-aware status copy all included as-is.
 */

/** Every real ISO country libphonenumber-js knows a dial code for, with a real display name (Intl.DisplayNames - no hand-maintained country list to go stale), sorted for a select dropdown. */
export const COUNTRY_DIAL_OPTIONS: { code: CountryCode; name: string; dialCode: string }[] = (() => {
  const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });
  return getCountries()
    .map((code) => ({ code, name: regionNames.of(code) ?? code, dialCode: getCountryCallingCode(code) }))
    .sort((a, b) => a.name.localeCompare(b.name));
})();

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

export function QrPanel({
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

/** U+1F1E6 is 127397 above 'A' - the standard two-letter-to-regional-indicator flag emoji trick. */
function flagEmoji(countryCode: string): string {
  return countryCode
    .toUpperCase()
    .replace(/./g, (char) => String.fromCodePoint(127397 + char.charCodeAt(0)));
}

/**
 * WhatsApp's real "Link with phone number" code is server-issued with no
 * expiry timestamp in Baileys' own response - only WhatsApp's servers know
 * exactly when it stops working, so this can't show a precise countdown
 * without risking telling the user a wrong number. What's reported
 * consistently (Baileys' own community docs, and this app's own testing)
 * is a real, short window of roughly a minute. Framed as an approximate
 * countdown with escalating urgency rather than a false "0:00 = dead"
 * claim, so the user knows to move fast without being told something that
 * might not be exactly true.
 */
const APPROX_CODE_WINDOW_SECONDS = 60;

function codeUrgency(generatedAtIso: string | null, now: number): { remaining: number; tier: 'fresh' | 'soon' | 'urgent' | 'expired' } | null {
  if (!generatedAtIso) return null;
  const elapsed = Math.max(0, Math.round((now - new Date(generatedAtIso).getTime()) / 1000));
  const remaining = APPROX_CODE_WINDOW_SECONDS - elapsed;
  if (remaining <= 0) return { remaining: 0, tier: 'expired' };
  if (remaining <= 15) return { remaining, tier: 'urgent' };
  if (remaining <= 30) return { remaining, tier: 'soon' };
  return { remaining, tier: 'fresh' };
}

/**
 * WhatsApp Web's own second linking method - enter a phone number, type
 * the resulting code into WhatsApp instead of scanning. Baileys never
 * auto-rotates this code the way it rotates a QR, so there's no
 * "generate a new code" gate behind a failure state here - the button is
 * always available, matching how the code can go silently stale with no
 * status change telling the UI.
 */
export function PhonePairingPanel({
  connection,
  onSubmit,
  submitting,
  submitError,
}: {
  connection: WhatsAppConnectionSnapshot | null;
  onSubmit: (fullPhoneNumber: string) => void;
  submitting: boolean;
  submitError: string | null;
}) {
  const [country, setCountry] = useState<CountryCode | ''>('');
  const [localNumber, setLocalNumber] = useState('');
  const status: Status = connection?.status ?? 'CONNECTING';
  const pairingCode = connection?.pairingCode ?? null;
  const copy = STATUS_COPY[status];

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const urgency = codeUrgency(connection?.pairingCodeGeneratedAt ?? null, now);

  const dialCode = country ? getCountryCallingCode(country) : null;

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!country || !localNumber.trim() || submitting) return;
    onSubmit(`+${getCountryCallingCode(country)}${localNumber.replace(/\D/g, '')}`);
  }

  return (
    <div className="w-full max-w-sm rounded-2xl border border-border-subtle bg-surface-1 p-6 shadow-xl sm:p-8">
      {!pairingCode ? (
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-body text-fg-secondary">
            Country
            <select
              required
              autoFocus
              value={country}
              onChange={(event) => setCountry(event.target.value as CountryCode)}
              className="rounded-lg border border-border-subtle bg-surface-1 px-3 py-2 text-body text-fg outline-none focus:border-accent"
            >
              <option value="" disabled>
                Select your country
              </option>
              {COUNTRY_DIAL_OPTIONS.map((option) => (
                <option key={option.code} value={option.code}>
                  {flagEmoji(option.code)} {option.name} (+{option.dialCode})
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-body text-fg-secondary">
            Phone number
            <div className="flex items-stretch gap-2">
              {dialCode && (
                <span className="flex items-center rounded-lg border border-border-subtle bg-surface-2 px-3 text-body text-fg-secondary">
                  +{dialCode}
                </span>
              )}
              <input
                type="tel"
                required
                placeholder="246 245 1422"
                value={localNumber}
                onChange={(event) => setLocalNumber(event.target.value)}
                className="min-w-0 flex-1 rounded-lg border border-border-subtle bg-surface-1 px-3 py-2 text-body text-fg outline-none focus:border-accent"
              />
            </div>
          </label>
          <p className="text-meta text-fg-muted">This is the number WhatsApp is already linked to on your phone.</p>
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
          {urgency && (
            <p
              className={
                'mt-2 flex items-center justify-center gap-1.5 text-meta font-medium ' +
                (urgency.tier === 'expired' || urgency.tier === 'urgent'
                  ? 'text-error'
                  : urgency.tier === 'soon'
                    ? 'text-warning'
                    : 'text-fg-muted')
              }
            >
              <RefreshCw size={11} aria-hidden />
              {urgency.tier === 'expired'
                ? 'This code has likely expired — request a new one below.'
                : `Enter it in the next ~${urgency.remaining}s, or request a new one.`}
            </p>
          )}
          {submitError && <p className="mt-2 text-caption text-error">{submitError}</p>}
          <button
            type="button"
            onClick={() => {
              // pairingPhoneNumber is always set alongside a live pairingCode
              // (see whatsappTenantConnection.ts's PAIRING_CODE_READY snapshot) -
              // the dial-code+local-number form above isn't mounted at this
              // point, so re-deriving from it isn't an option here.
              if (connection?.pairingPhoneNumber) onSubmit(connection.pairingPhoneNumber);
            }}
            disabled={submitting || !connection?.pairingPhoneNumber}
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
