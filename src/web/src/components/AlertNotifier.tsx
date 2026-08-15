import { useEffect, useRef, useState } from 'react';
import { api, type HumanTakeoverAlertDto } from '../lib/api.js';

const POLL_MS = 5000;

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
 * Zero-Leak Rule: the API response carries only a line ordinal and an
 * urgency tier (see securityAlertService.ts) - this component has no
 * message text, contact name, or phone number available to render even by
 * mistake.
 */
export function AlertNotifier() {
  const [alerts, setAlerts] = useState<HumanTakeoverAlertDto[]>([]);
  const seenChatIds = useRef<Set<string>>(new Set());

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

  if (alerts.length === 0) return null;

  return (
    <div className="pointer-events-none fixed inset-x-0 top-0 z-[60] flex flex-col items-center gap-2 p-3">
      {alerts.map((alert) => (
        <div
          key={alert.chatId}
          className={`pointer-events-auto flex animate-pulse items-center gap-2 rounded-full border px-4 py-2 text-sm font-medium shadow-2xl ${
            alert.urgency === 'HIGH'
              ? 'border-red-500/60 bg-red-500/15 text-red-300'
              : 'border-amber-500/60 bg-amber-500/15 text-amber-300'
          }`}
        >
          <span className="h-2 w-2 shrink-0 rounded-full bg-current" />
          {alert.lineLabel}: Urgent Lead Handover
        </div>
      ))}
    </div>
  );
}
