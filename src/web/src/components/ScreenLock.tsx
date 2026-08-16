import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Lock } from 'lucide-react';
import { api, ApiError } from '../lib/api.js';
import { DEFAULT_ARGON2_PARAMS, generateSalt, hashPin } from '../lib/pinCrypto.js';
import { useIdleTimer } from '../hooks/useIdleTimer.js';
import { AlertNotifier } from './AlertNotifier.js';

const IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const PIN_PATTERN = /^\d{6,8}$/;

interface Props {
  children: ReactNode;
}

/**
 * Application Lock Mode. Overlays `children` on idle timeout or Alt+L, and
 * never touches any background service - Baileys, the BullMQ worker, and
 * WebSocket listeners all run in separate Node processes untouched by this
 * component's state, so a locked UI never pauses live message ingestion.
 *
 * The PIN itself never leaves the browser: it's hashed with Argon2id (WASM,
 * see lib/pinCrypto.ts) before the server ever sees it.
 */
export function ScreenLock({ children }: Props) {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [locked, setLocked] = useState(false);
  const [pin, setPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [remainingAttempts, setRemainingAttempts] = useState<number | null>(null);
  const [revoked, setRevoked] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .getLockStatus()
      .then((status) => {
        if (!cancelled) setConfigured(status.configured);
      })
      .catch(() => {
        if (!cancelled) setConfigured(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const engageLock = useCallback(() => {
    setPin('');
    setConfirmPin('');
    setError(null);
    setLocked(true);
  }, []);

  useIdleTimer(IDLE_TIMEOUT_MS, engageLock, configured === true && !locked);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.altKey && event.key.toLowerCase() === 'l') {
        event.preventDefault();
        engageLock();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [engageLock]);

  async function handleSetupSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);

    if (!PIN_PATTERN.test(pin)) {
      setError('PIN must be 6 to 8 digits.');
      return;
    }
    if (pin !== confirmPin) {
      setError('PINs do not match.');
      return;
    }

    setBusy(true);
    try {
      const salt = generateSalt();
      const pinHash = await hashPin(pin, salt);
      await api.setupLock({ salt, pinHash, argon2Params: DEFAULT_ARGON2_PARAMS });
      setConfigured(true);
      setLocked(false);
      setPin('');
      setConfirmPin('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to set up the PIN.');
    } finally {
      setBusy(false);
    }
  }

  async function handleUnlockSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);

    try {
      const challenge = await api.getUnlockChallenge();
      const pinHash = await hashPin(pin, challenge.salt, challenge.argon2Params);
      const result = await api.attemptUnlock(pinHash);
      setPin('');

      if (result.unlocked) {
        setLocked(false);
        setRemainingAttempts(null);
        return;
      }

      setRemainingAttempts(result.remainingAttempts);
      if (result.revoked) {
        setRevoked(true);
        setError('Too many failed attempts. This lock has been revoked.');
      } else {
        setError(
          result.remainingAttempts != null
            ? `Incorrect PIN. ${result.remainingAttempts} attempt${result.remainingAttempts === 1 ? '' : 's'} remaining.`
            : 'Incorrect PIN.',
        );
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to verify PIN.');
    } finally {
      setBusy(false);
    }
  }

  const overlayVisible = locked && configured !== null;
  const showSetupForm = overlayVisible && !configured;

  return (
    <>
      {children}
      <AlertNotifier />

      {overlayVisible && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-surface-0/95 p-4 backdrop-blur-md">
          <div className="w-full max-w-sm rounded-2xl border border-border-subtle bg-surface-1 p-6 shadow-2xl">
            <div className="mb-4 flex flex-col items-center gap-2 text-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-surface-2 text-emerald-400">
                <Lock size={22} strokeWidth={1.75} aria-hidden />
              </div>
              <h2 className="text-lg font-semibold text-gray-100">
                {showSetupForm ? 'Set up a lock PIN' : 'Workspace locked'}
              </h2>
              <p className="text-xs text-gray-500">
                {showSetupForm
                  ? 'Choose a 6-8 digit PIN. It is hashed on this device and never sent in the clear.'
                  : 'Enter your PIN to resume. Live messaging and AI processing keep running in the background.'}
              </p>
            </div>

            {showSetupForm ? (
              <form onSubmit={handleSetupSubmit} className="flex flex-col gap-3">
                <input
                  type="password"
                  inputMode="numeric"
                  autoFocus
                  placeholder="New PIN (6-8 digits)"
                  value={pin}
                  onChange={(event) => setPin(event.target.value.replace(/\D/g, '').slice(0, 8))}
                  className="rounded-lg border border-border-subtle bg-surface-2 px-3 py-2 text-center text-lg tracking-[0.3em] text-gray-100 outline-none focus:border-accent"
                />
                <input
                  type="password"
                  inputMode="numeric"
                  placeholder="Confirm PIN"
                  value={confirmPin}
                  onChange={(event) => setConfirmPin(event.target.value.replace(/\D/g, '').slice(0, 8))}
                  className="rounded-lg border border-border-subtle bg-surface-2 px-3 py-2 text-center text-lg tracking-[0.3em] text-gray-100 outline-none focus:border-accent"
                />
                {error && <p className="text-center text-xs text-red-400">{error}</p>}
                <button
                  type="submit"
                  disabled={busy}
                  className="rounded-lg bg-accent px-3 py-2 text-sm font-medium text-surface-0 transition hover:bg-accent-dim disabled:opacity-50"
                >
                  {busy ? 'Saving…' : 'Set PIN and lock'}
                </button>
              </form>
            ) : (
              <form onSubmit={handleUnlockSubmit} className="flex flex-col gap-3">
                <input
                  type="password"
                  inputMode="numeric"
                  autoFocus
                  disabled={revoked}
                  placeholder="Enter PIN"
                  value={pin}
                  onChange={(event) => setPin(event.target.value.replace(/\D/g, '').slice(0, 8))}
                  className="rounded-lg border border-border-subtle bg-surface-2 px-3 py-2 text-center text-lg tracking-[0.3em] text-gray-100 outline-none focus:border-accent disabled:opacity-50"
                />
                {error && <p className="text-center text-xs text-red-400">{error}</p>}
                {remainingAttempts !== null && !revoked && (
                  <p className="text-center text-[11px] text-gray-500">{remainingAttempts} attempts remaining before lockout.</p>
                )}
                <button
                  type="submit"
                  disabled={busy || revoked || !PIN_PATTERN.test(pin)}
                  className="rounded-lg bg-accent px-3 py-2 text-sm font-medium text-surface-0 transition hover:bg-accent-dim disabled:opacity-50"
                >
                  {busy ? 'Verifying…' : 'Unlock'}
                </button>
              </form>
            )}
          </div>
        </div>
      )}
    </>
  );
}
