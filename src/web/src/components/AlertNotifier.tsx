import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { X } from 'lucide-react';
import { api, type HumanTakeoverAlertDto } from '../lib/api.js';

const POLL_MS = 5000;
const ROTATE_MS = 5000;

export const ALERT_SHOW_IDENTITY_KEY = 'alert_banner_show_identity';
const DEFAULT_SHOW_IDENTITY = false;

export function getAlertShowIdentity(): boolean {
  try {
    return localStorage.getItem(ALERT_SHOW_IDENTITY_KEY) === 'true';
  } catch {
    return DEFAULT_SHOW_IDENTITY;
  }
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
  // urgent handoff should never be cycled past a pile of lower ones.
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
 * A compact, color-coded pill mounted in exactly two places: the
 * workspace's own top header bar (WorkspaceShell.tsx) for the normal
 * unlocked view, and again inside ScreenLock's lock overlay (off to the
 * side of the PIN card) so a live handoff stays visible while locked - not
 * a floating overlay that follows the viewport around on its own anymore.
 * With more than one unresolved handoff, it automatically cycles through
 * them one at a time every few seconds, so a busy line with several
 * waiting customers is never represented by just the first (or loudest)
 * one. Clicking the pill opens that chat WITHOUT dismissing it - only the
 * X removes it (or the underlying handoff genuinely resolving
 * server-side), so glancing at a chat to check on it never silently loses
 * the alert. Each mount polls/dismisses independently (component-local
 * state), so dismissing one on the lock screen and the other in the
 * header is expected, not a bug.
 *
 * Zero-Leak Rule (default): the API response carries only the business's
 * own WhatsApp line label and an urgency tier - no customer name, phone
 * number, or message text. "Show customer name/number" (Settings -> Alerts,
 * off by default) opts into requesting real per-customer identity instead;
 * see securityAlertService.ts for why that's an explicit, request-scoped
 * opt-in rather than always-fetched-but-hidden.
 */
export function AlertNotifier() {
  const navigate = useNavigate();
  const [alerts, setAlerts] = useState<HumanTakeoverAlertDto[]>([]);
  const [dismissed, setDismissed] = useState<Record<string, string>>({});
  const [showIdentity, setShowIdentity] = useState<boolean>(getAlertShowIdentity);
  const [rotationIndex, setRotationIndex] = useState(0);
  const seenChatIds = useRef<Set<string>>(new Set());

  // Appearance -> Alerts writes this same key and dispatches this same
  // event (see SettingsRoute.tsx's AlertBannerCard) - the exact pattern
  // ScreenLock.tsx already uses for LOCK_TIMEOUT_KEY, so a change applies
  // live without a reload.
  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key === ALERT_SHOW_IDENTITY_KEY) setShowIdentity(getAlertShowIdentity());
    }
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  // Opening a chat is the acknowledgement boundary for its human-takeover
  // alert. Keep this local dismissal separate from the server-side takeover
  // state: the AI may remain paused briefly while the human finishes typing,
  // but the top-bar alert should not obstruct the chat they are handling.
  useEffect(() => {
    function onChatOpened(event: Event) {
      const chatId = (event as CustomEvent<{ chatId?: string }>).detail?.chatId;
      if (!chatId) return;
      setDismissed((prev) => {
        const alert = alerts.find((candidate) => candidate.chatId === chatId);
        if (!alert || prev[chatId] === alert.triggeredAt) return prev;
        return { ...prev, [chatId]: alert.triggeredAt };
      });
    }
    window.addEventListener('aura:chat-opened', onChatOpened);
    return () => window.removeEventListener('aura:chat-opened', onChatOpened);
  }, [alerts]);

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

  const visibleAlerts = alerts.filter((alert) => dismissed[alert.chatId] !== alert.triggeredAt);
  const groups = groupAlerts(visibleAlerts, showIdentity);

  // Keeps the rotation index in range as groups resolve/get dismissed out
  // from under it, rather than pointing past the end of a shrunk list.
  useEffect(() => {
    if (rotationIndex >= groups.length) setRotationIndex(0);
  }, [groups.length, rotationIndex]);

  useEffect(() => {
    if (groups.length <= 1) return;
    const timer = setInterval(() => setRotationIndex((i) => (i + 1) % groups.length), ROTATE_MS);
    return () => clearInterval(timer);
  }, [groups.length]);

  if (groups.length === 0) return null;
  const current = groups[rotationIndex % groups.length]!;

  function mostRecent(group: AlertGroup): HumanTakeoverAlertDto {
    return [...group.alerts].sort((a, b) => b.triggeredAt.localeCompare(a.triggeredAt))[0]!;
  }

  return (
    <button
      type="button"
      onClick={() => {
        const chatId = mostRecent(current).chatId;
        dismissGroup(current);
        window.dispatchEvent(new CustomEvent('aura:chat-opened', { detail: { chatId } }));
        navigate(`/chats/${chatId}`);
      }}
      title="Open this chat"
      className={`flex max-w-xs items-center gap-2 rounded-full border px-3 py-1 text-caption font-medium transition ${
        current.urgency === 'HIGH' ? 'border-error/60 bg-error/15 text-error' : 'border-warning/60 bg-warning/15 text-warning'
      }`}
    >
      <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-current" />
      <span className="min-w-0 truncate">{groupLabel(current, showIdentity)}</span>
      {groups.length > 1 && <span className="shrink-0 opacity-70">{rotationIndex + 1}/{groups.length}</span>}
      <span
        role="button"
        tabIndex={0}
        title="Dismiss"
        onClick={(event) => {
          event.stopPropagation();
          dismissGroup(current);
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.stopPropagation();
          dismissGroup(current);
        }}
        className="shrink-0 rounded-full p-0.5 opacity-70 transition hover:bg-black/10 hover:opacity-100 dark:hover:bg-white/10"
      >
        <X size={13} aria-hidden />
      </span>
    </button>
  );
}
