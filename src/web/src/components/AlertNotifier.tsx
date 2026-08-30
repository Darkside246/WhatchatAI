import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type HumanTakeoverAlertDto } from '../lib/api.js';

const POLL_MS = 5000;

export const ALERT_POSITION_KEY = 'alert_banner_position';
export const ALERT_SCALE_KEY = 'alert_banner_scale';
export type AlertBannerPosition = 'left' | 'right';
const DEFAULT_ALERT_POSITION: AlertBannerPosition = 'right';
const DEFAULT_ALERT_SCALE = 1;
export const ALERT_SCALE_MIN = 0.75;
export const ALERT_SCALE_MAX = 1.5;

function getAlertPosition(): AlertBannerPosition {
  try {
    const v = localStorage.getItem(ALERT_POSITION_KEY);
    if (v === 'left' || v === 'right') return v;
  } catch {}
  return DEFAULT_ALERT_POSITION;
}

function getAlertScale(): number {
  try {
    const n = parseFloat(localStorage.getItem(ALERT_SCALE_KEY) ?? '');
    if (!isNaN(n) && n >= ALERT_SCALE_MIN && n <= ALERT_SCALE_MAX) return n;
  } catch {}
  return DEFAULT_ALERT_SCALE;
}

/** A short, in-browser tone via Web Audio - no external audio file or third-party fetch involved. */
function playChime(): void {
  try {
    const AudioContextCtor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new AudioContextCtor();
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.value = 880;
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.2, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.5);
    oscillator.connect(gain);
    gain.connect(ctx.destination);
    oscillator.start();
    oscillator.stop(ctx.currentTime + 0.5);
    oscillator.onended = () => void ctx.close();
  } catch {
    // Audio is a nice-to-have; the visual alert below is the real signal.
  }
}

/**
 * Polls the real HUMAN_TAKEOVER_REQUIRED alert feed and renders a pulsing
 * banner + chime for anything new. Always mounted, independent of the lock
 * screen's locked/unlocked state - background handoffs must stay visible
 * even while the UI is locked.
 *
 * Zero-Leak Rule: the API response carries only the business's own WhatsApp
 * line label and an urgency tier (see securityAlertService.ts) - this
 * component has no *customer* message text, contact name, or phone number
 * available to render even by mistake. Clicking an alert opens the
 * triggering chat directly and dismisses that banner immediately - it
 * only reappears if `triggeredAt` moves forward (a genuinely new event on
 * that chat), not merely because the underlying HUMAN_TAKEOVER condition
 * is still true on the next poll.
 */
export function AlertNotifier() {
  const [alerts, setAlerts] = useState<HumanTakeoverAlertDto[]>([]);
  const [dismissed, setDismissed] = useState<Record<string, string>>({});
  const [position, setPosition] = useState<AlertBannerPosition>(getAlertPosition);
  const [scale, setScale] = useState<number>(getAlertScale);
  const seenChatIds = useRef<Set<string>>(new Set());

  // Appearance -> Alerts writes these same keys and dispatches this same
  // event (see SettingsRoute.tsx's AlertBannerCard) - the exact pattern
  // ScreenLock.tsx already uses for LOCK_TIMEOUT_KEY, so a change applies
  // live without a reload.
  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key === ALERT_POSITION_KEY) setPosition(getAlertPosition());
      if (e.key === ALERT_SCALE_KEY) setScale(getAlertScale());
    }
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function poll() {
      try {
        const { alerts: fetched } = await api.listHumanTakeoverAlerts();
        if (cancelled) return;
        const hasNewAlert = fetched.some((alert) => !seenChatIds.current.has(alert.chatId));
        if (hasNewAlert) playChime();
        seenChatIds.current = new Set(fetched.map((alert) => alert.chatId));
        setAlerts(fetched);
      } catch {
        // Best-effort: a failed poll shouldn't disrupt the rest of the app.
      } finally {
        if (!cancelled) timer = setTimeout(poll, POLL_MS);
      }
    }

    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);

  // HIGH-urgency alerts always lead the stack, regardless of arrival order -
  // the most urgent handoff should never be scrolled past a pile of lower ones.
  const visibleAlerts = alerts
    .filter((alert) => dismissed[alert.chatId] !== alert.triggeredAt)
    .sort((a, b) => (a.urgency === b.urgency ? 0 : a.urgency === 'HIGH' ? -1 : 1));

  if (visibleAlerts.length === 0) return null;

  return (
    <div
      className={`pointer-events-none fixed top-4 z-[60] flex flex-col gap-2 p-3 ${
        position === 'left' ? 'left-4 items-start' : 'right-4 items-end'
      }`}
      style={{ transform: `scale(${scale})`, transformOrigin: position === 'left' ? 'top left' : 'top right' }}
    >
      {visibleAlerts.map((alert) => (
        <Link
          key={alert.chatId}
          to={`/chats/${alert.chatId}`}
          onClick={() => setDismissed((prev) => ({ ...prev, [alert.chatId]: alert.triggeredAt }))}
          className={`pointer-events-auto flex animate-pulse items-center gap-2 rounded-full border px-4 py-2 text-body font-medium shadow-2xl transition hover:animate-none ${
            alert.urgency === 'HIGH' ? 'border-error/60 bg-error/15 text-error' : 'border-warning/60 bg-warning/15 text-warning'
          }`}
        >
          <span className="h-2 w-2 shrink-0 rounded-full bg-current" />
          {alert.lineLabel}: Urgent Lead Handover
        </Link>
      ))}
    </div>
  );
}
