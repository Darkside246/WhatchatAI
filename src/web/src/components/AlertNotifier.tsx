import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
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
 * one. Opening the conversation dismisses its pill - by clicking the pill
 * or by reaching that chat any other way - because opening it IS the
 * acknowledgement, and an alert still shouting about the thread the
 * operator is reading right now is the noise they have to clear twice. The
 * X remains for dismissing without opening, and a handoff genuinely
 * resolving server-side still clears it on its own.
 *
 * Detected from the router rather than a cross-component event, so it holds
 * however the chat was reached and the two components stay uncoupled. It is
 * deliberately a LOCAL dismissal only: the server-side takeover state is
 * untouched, so the AI stays paused while the human finishes handling it.
 * Each mount polls/dismisses independently (component-local
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
  const location = useLocation();
  const [alerts, setAlerts] = useState<HumanTakeoverAlertDto[]>([]);
  const [dismissed, setDismissed] = useState<Record<string, string>>({});
  const [showIdentity, setShowIdentity] = useState<boolean>(getAlertShowIdentity);
  const [rotationIndex, setRotationIndex] = useState(0);
  const seenChatIds = useRef<Set<string>>(new Set());
  /**
   * Whether a poll has completed yet on this mount.
   *
   * seenChatIds starts empty, so on the FIRST poll after a page load every
   * outstanding alert looks new and the chime fired for the whole backlog -
   * a burst of sound on every login and every refresh, announcing nothing
   * that had just happened. The first poll seeds the set silently; only
   * what arrives after that is genuinely news.
   */
  const hasPolled = useRef(false);
  /**
   * The chat currently open, read inside the poll without making it a
   * dependency - re-running the poll effect on every navigation would reset
   * the backoff and re-seed seenChatIds.
   */
  const openChatIdRef = useRef<string | null>(null);

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

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function poll() {
      try {
        const { alerts: fetched } = await api.listHumanTakeoverAlerts(showIdentity);
        if (cancelled) return;
        // Never for a conversation already on screen: the operator is
        // looking straight at it, and a sound about the thing in front of
        // you is pure noise. Never on the first poll either - see hasPolled.
        const hasNewAlert = fetched.some(
          (alert) => !seenChatIds.current.has(alert.chatId) && alert.chatId !== openChatIdRef.current,
        );
        if (hasNewAlert && hasPolled.current) playChime();
        hasPolled.current = true;
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

  // Opening a conversation acknowledges its alert. Keyed on triggeredAt like
  // every other dismissal here, so a genuinely NEW handoff on the same chat
  // raises the pill again rather than staying permanently silenced.
  const openChatId = /^\/chats\/([^/]+)$/.exec(location.pathname)?.[1] ?? null;
  openChatIdRef.current = openChatId;
  useEffect(() => {
    if (!openChatId) return;
    const alert = alerts.find((candidate) => candidate.chatId === openChatId);
    if (!alert) return;
    setDismissed((previous) => (previous[openChatId] === alert.triggeredAt ? previous : { ...previous, [openChatId]: alert.triggeredAt }));
  }, [openChatId, alerts]);

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

  /**
   * How many conversations are really outstanding right now, across every
   * group - not how many pills happen to be in the rotation.
   *
   * With identity display off (the privacy default) alerts on the same line
   * and urgency collapse into a single group, so the pill had nothing to
   * rotate between and simply sat on one entry: there was no way to tell
   * two waiting conversations from ten. The count is the honest answer to
   * "how much is outstanding", and it is a real count of live alerts, never
   * an estimate.
   */
  const outstandingCount = visibleAlerts.length;

  if (groups.length === 0) return null;
  const current = groups[rotationIndex % groups.length]!;

  function mostRecent(group: AlertGroup): HumanTakeoverAlertDto {
    return [...group.alerts].sort((a, b) => b.triggeredAt.localeCompare(a.triggeredAt))[0]!;
  }

  return (
    <button
      type="button"
      onClick={() => navigate(`/chats/${mostRecent(current).chatId}`)}
      title="Open this chat"
      // Has to be able to shrink on a phone. max-w-xs alone is 320px, which
      // on a ~390px screen leaves nothing for the search button, the bell and
      // the account menu either side of it - the row overflowed and the pill
      // was clipped mid-word against the edge.
      className={`flex min-w-0 max-w-[52vw] items-center gap-2 rounded-full border px-3 py-1 text-caption font-medium transition sm:max-w-xs ${
        current.urgency === 'HIGH' ? 'border-error/60 bg-error/15 text-error' : 'border-warning/60 bg-warning/15 text-warning'
      }`}
    >
      <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-current" />
      <span className="min-w-0 truncate">{groupLabel(current, showIdentity)}</span>
      {outstandingCount > 1 && (
        <span
          title={`${outstandingCount} conversations waiting on a human`}
          className="shrink-0 rounded-full bg-current/20 px-1.5 py-0.5 text-meta font-semibold tabular-nums"
        >
          {outstandingCount > 99 ? '99+' : outstandingCount}
        </span>
      )}
      {/* Only meaningful while there is genuinely more than one pill to cycle through. */}
      {groups.length > 1 && <span className="shrink-0 opacity-70 tabular-nums">{rotationIndex + 1}/{groups.length}</span>}
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
