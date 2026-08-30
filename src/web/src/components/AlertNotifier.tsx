import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { X } from 'lucide-react';
import { api, type HumanTakeoverAlertDto } from '../lib/api.js';

const POLL_MS = 5000;

export const ALERT_SCALE_KEY = 'alert_banner_scale';
const DEFAULT_ALERT_SCALE = 1;
export const ALERT_SCALE_MIN = 0.75;
export const ALERT_SCALE_MAX = 1.5;

export const ALERT_POSITION_KEY = 'alert_banner_position';
export type AlertBannerPosition = 'left' | 'center' | 'right';
const DEFAULT_ALERT_POSITION: AlertBannerPosition = 'center';

export const ALERT_SHOW_IDENTITY_KEY = 'alert_banner_show_identity';
const DEFAULT_SHOW_IDENTITY = false;

function getAlertScale(): number {
  try {
    const n = parseFloat(localStorage.getItem(ALERT_SCALE_KEY) ?? '');
    if (!isNaN(n) && n >= ALERT_SCALE_MIN && n <= ALERT_SCALE_MAX) return n;
  } catch {}
  return DEFAULT_ALERT_SCALE;
}

function getAlertPosition(): AlertBannerPosition {
  try {
    const v = localStorage.getItem(ALERT_POSITION_KEY);
    if (v === 'left' || v === 'center' || v === 'right') return v;
  } catch {}
  return DEFAULT_ALERT_POSITION;
}

export function getAlertShowIdentity(): boolean {
  try {
    return localStorage.getItem(ALERT_SHOW_IDENTITY_KEY) === 'true';
  } catch {
    return DEFAULT_SHOW_IDENTITY;
  }
}

const POSITION_CONTAINER_CLASS: Record<AlertBannerPosition, string> = {
  left: 'justify-start',
  center: 'justify-center',
  right: 'justify-end',
};
const POSITION_ORIGIN: Record<AlertBannerPosition, string> = {
  left: 'top left',
  center: 'top center',
  right: 'top right',
};

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

interface AlertGroup {
  key: string;
  lineLabel: string;
  urgency: HumanTakeoverAlertDto['urgency'];
  alerts: HumanTakeoverAlertDto[];
}

/**
 * Identity off (default): same line + same urgency collapses into one entry
 * with a count, instead of N visually-identical banners piling up - there's
 * nothing to tell them apart by anyway. Identity on: every alert is its own
 * group (a real, distinct customer name/number to show), never collapsed.
 */
function groupAlerts(alerts: HumanTakeoverAlertDto[], showIdentity: boolean): AlertGroup[] {
  const groups = new Map<string, AlertGroup>();
  for (const alert of alerts) {
    const key = showIdentity ? alert.chatId : `${alert.lineLabel}::${alert.urgency}`;
    const existing = groups.get(key);
    if (existing) existing.alerts.push(alert);
    else groups.set(key, { key, lineLabel: alert.lineLabel, urgency: alert.urgency, alerts: [alert] });
  }
  // HIGH-urgency groups always lead, regardless of arrival order - the most
  // urgent handoff should never be scrolled past a pile of lower ones.
  return [...groups.values()].sort((a, b) => (a.urgency === b.urgency ? 0 : a.urgency === 'HIGH' ? -1 : 1));
}

function groupLabel(group: AlertGroup, showIdentity: boolean): string {
  if (showIdentity) {
    const alert = group.alerts[0]!;
    const who = alert.customerName || alert.customerPhoneNumber || 'Unknown contact';
    return `${who}: urgent lead handover`;
  }
  return `${group.lineLabel}: ${group.alerts.length > 1 ? `${group.alerts.length} urgent lead handovers` : 'Urgent lead handover'}`;
}

/**
 * Polls the real HUMAN_TAKEOVER_REQUIRED alert feed and renders a single,
 * contained top panel for anything unresolved - never floating pills that
 * can overlap or bleed past other UI. Mounted only once the workspace is
 * genuinely ready (see App.tsx) - never during onboarding/QR pairing/sync,
 * so a screen left open mid-setup never surfaces live operational data.
 *
 * Zero-Leak Rule (default): the API response carries only the business's
 * own WhatsApp line label and an urgency tier - no customer name, phone
 * number, or message text. "Show customer name/number" (Settings -> Alerts,
 * off by default) opts into requesting real per-customer identity instead;
 * see securityAlertService.ts for why that's an explicit, request-scoped
 * opt-in rather than always-fetched-but-hidden. With identity off, several
 * unresolved handoffs on the same line are visually identical to each other
 * for that same reason, so they're grouped into one entry with a count
 * rather than repeated.
 */
export function AlertNotifier() {
  const navigate = useNavigate();
  const [alerts, setAlerts] = useState<HumanTakeoverAlertDto[]>([]);
  const [dismissed, setDismissed] = useState<Record<string, string>>({});
  const [scale, setScale] = useState<number>(getAlertScale);
  const [position, setPosition] = useState<AlertBannerPosition>(getAlertPosition);
  const [showIdentity, setShowIdentity] = useState<boolean>(getAlertShowIdentity);
  const seenChatIds = useRef<Set<string>>(new Set());

  // Appearance -> Alerts writes these same keys and dispatches this same
  // event (see SettingsRoute.tsx's AlertBannerCard) - the exact pattern
  // ScreenLock.tsx already uses for LOCK_TIMEOUT_KEY, so a change applies
  // live without a reload.
  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key === ALERT_SCALE_KEY) setScale(getAlertScale());
      if (e.key === ALERT_POSITION_KEY) setPosition(getAlertPosition());
      if (e.key === ALERT_SHOW_IDENTITY_KEY) setShowIdentity(getAlertShowIdentity());
    }
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function poll() {
      try {
        const { alerts: fetched } = await api.listHumanTakeoverAlerts(showIdentity);
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
    // Re-polls immediately with the new includeIdentity value the moment the
    // setting changes, rather than waiting up to POLL_MS for the next tick.
  }, [showIdentity]);

  function dismissGroup(group: AlertGroup) {
    setDismissed((prev) => {
      const next = { ...prev };
      for (const alert of group.alerts) next[alert.chatId] = alert.triggeredAt;
      return next;
    });
  }

  function clearAll() {
    setDismissed((prev) => {
      const next = { ...prev };
      for (const alert of alerts) next[alert.chatId] = alert.triggeredAt;
      return next;
    });
  }

  const visibleAlerts = alerts.filter((alert) => dismissed[alert.chatId] !== alert.triggeredAt);
  const groups = groupAlerts(visibleAlerts, showIdentity);

  if (groups.length === 0) return null;

  // Newest-first within a group so clicking it opens the chat that most
  // needs attention right now, not whichever happened to arrive first.
  function mostRecent(group: AlertGroup): HumanTakeoverAlertDto {
    return [...group.alerts].sort((a, b) => b.triggeredAt.localeCompare(a.triggeredAt))[0]!;
  }

  return (
    <div className={`pointer-events-none fixed inset-x-0 top-0 z-[60] flex p-3 ${POSITION_CONTAINER_CLASS[position]}`}>
      <div
        className="pointer-events-auto flex w-full max-w-xl flex-col gap-1.5 rounded-2xl border border-border-subtle bg-surface-1/95 p-2 shadow-2xl backdrop-blur"
        style={{ transform: `scale(${scale})`, transformOrigin: POSITION_ORIGIN[position] }}
      >
        <div className="flex max-h-80 flex-col gap-1.5 overflow-y-auto">
          {groups.map((group) => (
            <div
              key={group.key}
              role="button"
              tabIndex={0}
              onClick={() => {
                dismissGroup(group);
                navigate(`/chats/${mostRecent(group).chatId}`);
              }}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                dismissGroup(group);
                navigate(`/chats/${mostRecent(group).chatId}`);
              }}
              className={`flex animate-pulse cursor-pointer items-start gap-2 rounded-xl border px-3 py-2 text-body font-medium transition hover:animate-none ${
                group.urgency === 'HIGH' ? 'border-error/60 bg-error/15 text-error' : 'border-warning/60 bg-warning/15 text-warning'
              }`}
            >
              <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-current" />
              <span className="min-w-0 flex-1 whitespace-normal break-words">{groupLabel(group, showIdentity)}</span>
              <button
                type="button"
                title="Dismiss"
                onClick={(event) => {
                  event.stopPropagation();
                  dismissGroup(group);
                }}
                className="shrink-0 rounded-full p-0.5 opacity-70 transition hover:bg-black/10 hover:opacity-100 dark:hover:bg-white/10"
              >
                <X size={14} aria-hidden />
              </button>
            </div>
          ))}
        </div>

        {visibleAlerts.length > 1 && (
          <button
            type="button"
            onClick={clearAll}
            className="self-center rounded-full px-3 py-1 text-caption font-medium text-fg-muted transition hover:bg-surface-2 hover:text-fg"
          >
            Clear all
          </button>
        )}
      </div>
    </div>
  );
}
