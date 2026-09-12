import { useEffect, useRef, useState } from 'react';
import { api, type SyncStatusResponse, type WhatsAppConnectionSnapshot } from '../lib/api.js';

export type AppPhase = 'loading' | 'onboarding' | 'syncing' | 'operator-setup' | 'brand-dna' | 'workspace';

export interface AppGateState {
  phase: AppPhase;
  connection: WhatsAppConnectionSnapshot | null;
  sync: SyncStatusResponse | null;
  /**
   * True once several consecutive status polls have failed - the backend is
   * unreachable (crashed, restarting, network blip), not just "no WhatsApp
   * connection yet". Without this, a dead backend left `connection` frozen
   * at its last successful snapshot forever, with nothing telling the user
   * the QR code on screen had gone stale - it silently stopped rotating and
   * just looked broken, with no way to tell "genuinely invalid" apart from
   * "the page hasn't heard from the server in a while."
   */
  serverUnreachable: boolean;
  continueAnyway: () => void;
  skipOperatorSetup: () => void;
  /** Leaves the Brand DNA step for later and goes straight to the workspace. The profile can still be built any time from Settings. */
  skipBrandDna: () => void;
}

const STATUS_POLL_MS = 2500;
const SYNC_POLL_MS = 2000;
/** 3 consecutive failures (~7.5s at the poll interval above) before surfacing "unreachable" - long enough to ride out one dropped request, short enough that a real backend crash is disclosed quickly rather than leaving a stale QR on screen indefinitely. */
const UNREACHABLE_AFTER_CONSECUTIVE_FAILURES = 3;

/** Real polling of the real backend - never a simulated/timed transition. */
export function useAppGate(): AppGateState {
  const [connection, setConnection] = useState<WhatsAppConnectionSnapshot | null>(null);
  const [sync, setSync] = useState<SyncStatusResponse | null>(null);
  const [forceContinue, setForceContinue] = useState(false);
  const [operatorConfigured, setOperatorConfigured] = useState<boolean | null>(null);
  const [skipOperator, setSkipOperator] = useState(false);
  const [brandDnaComplete, setBrandDnaComplete] = useState<boolean | null>(null);
  const [skipBrandDna, setSkipBrandDna] = useState(false);
  // Baileys drops and auto-reconnects an already-paired session constantly
  // (a near-guaranteed restartRequired right after first pairing, plus
  // transient blips during/after a large history sync). None of that means
  // the account needs re-pairing, so once we've seen a real connection we
  // stop treating momentary disconnects as "show the QR screen again."
  const [pairedOnce, setPairedOnce] = useState(false);
  const [serverUnreachable, setServerUnreachable] = useState(false);
  const consecutiveFailures = useRef(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function poll() {
      // Nothing is read while nobody is looking. The loop keeps its shape
      // and its timer - the request, the parse and the re-render are what
      // cost anything, and they are what is skipped. Coming back to the tab
      // fires a fetch immediately (see the visibilitychange listener below)
      // rather than waiting out the remaining interval.
      if (document.hidden) {
        if (mounted.current) timer = setTimeout(poll, STATUS_POLL_MS);
        return;
      }
      try {
        const snapshot = await api.getWhatsAppStatus();
        consecutiveFailures.current = 0;
        if (mounted.current) {
          setServerUnreachable(false);
          setConnection(snapshot);
          // everConnectedBefore is a real, persisted fact (survives a
          // backend restart's in-memory reset) - a fresh tab whose very
          // first poll lands mid-reconnect must not be treated the same as
          // a business that has genuinely never paired (see this route's
          // own doc comment in server/index.ts).
          if (snapshot.connected || snapshot.everConnectedBefore) setPairedOnce(true);
          if (snapshot.status === 'LOGGED_OUT') setPairedOnce(false);
        }
      } catch {
        // Backend not reachable yet - keep retrying, don't fabricate a
        // status. `connection` itself is deliberately left alone (never
        // nulled out here) - once several polls in a row have failed,
        // serverUnreachable tells the UI that whatever snapshot is still
        // showing (a QR code, most importantly) is stale, without erasing
        // it outright the moment the very first request drops.
        consecutiveFailures.current += 1;
        if (mounted.current && consecutiveFailures.current >= UNREACHABLE_AFTER_CONSECUTIVE_FAILURES) {
          setServerUnreachable(true);
        }
      } finally {
        if (mounted.current) timer = setTimeout(poll, STATUS_POLL_MS);
      }
    }

    void poll();

    // Coming back to the tab re-reads at once, so a stale connection status
    // is never what greets someone returning to the page.
    const onVisible = () => {
      if (!document.hidden) {
        clearTimeout(timer);
        void poll();
      }
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  useEffect(() => {
    // Keep the last known sync snapshot across a brief reconnect of an
    // already-paired session instead of nulling it out - that null was what
    // bounced a fully-synced workspace back to the "Synchronizing…" screen
    // every time Baileys blipped.
    if (!connection?.connected && !pairedOnce) {
      setSync(null);
      return;
    }
    if (!connection?.connected) return;

    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;

    async function poll() {
      try {
        const status = await api.getSyncStatus();
        if (mounted.current && !cancelled) setSync(status);
      } catch {
        // sync-status 409s until the account row is persisted right after connect - keep polling.
      } finally {
        if (mounted.current && !cancelled) timer = setTimeout(poll, SYNC_POLL_MS);
      }
    }

    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [connection?.connected, pairedOnce]);

  // Whether this business has ever built a Brand DNA profile. Checked once,
  // after sync, for the same reason operator setup is: a brand-new account
  // has nothing, and asking is only worth doing when there is real synced
  // data behind it.
  useEffect(() => {
    if (!forceContinue && !sync) return;
    const syncDone = forceContinue || sync?.syncStatus === 'completed';
    if (!syncDone || brandDnaComplete !== null) return;
    api
      .getBrandDnaProfile()
      .then((result) => {
        if (mounted.current) setBrandDnaComplete(result.profile?.status === 'complete');
      })
      // On error, treat it as done and go straight to the workspace. Brand
      // DNA is valuable, not load-bearing - it must never be the reason
      // someone cannot reach their inbox.
      .catch(() => {
        if (mounted.current) setBrandDnaComplete(true);
      });
  }, [forceContinue, sync, brandDnaComplete]);

  // Check operator mode configuration once after sync completes.
  useEffect(() => {
    if (!forceContinue && !sync) return;
    const syncDone = forceContinue || (sync?.syncStatus === 'completed');
    if (!syncDone || operatorConfigured !== null) return;
    api.getOperatorSettings()
      .then((s) => { if (mounted.current) setOperatorConfigured(s.configured); })
      .catch(() => { if (mounted.current) setOperatorConfigured(true); }); // on error: skip the step
  }, [forceContinue, sync, operatorConfigured]);

  let phase: AppPhase = 'loading';
  if (connection) {
    const needsOnboarding =
      connection.status === 'QR_READY' ||
      connection.status === 'PAIRING_CODE_READY' ||
      connection.status === 'LOGGED_OUT' ||
      // A genuine WhatsApp-side conflict (another device took over the
      // linked-device slot) - real, terminal, needs a fresh pairing
      // regardless of pairedOnce/everConnectedBefore, unlike a merely
      // transient reconnect.
      connection.status === 'CONFLICT_REPLACED' ||
      // Real, confirmed bug fixed here: this used to also exclude
      // `connection.status !== 'RECONNECTING'`, on the theory that
      // RECONNECTING only ever follows a real prior connection (true of
      // the WhatsApp-mandated post-pairing restart - Baileys' "stream:error
      // code 515, restart required" - see whatsappTenantConnection.ts's
      // hasPairedThisSession doc comment). That's false in general:
      // scheduleReconnect() sets RECONNECTING after ANY failed connection
      // attempt, including one that has never once reached a real 'open'
      // event (confirmed in production: a business with zero
      // whatsapp_accounts rows still hit RECONNECTING after a Baileys
      // DisconnectReason.connectionClosed failure mid-pairing). Excluding
      // all of RECONNECTING sent that business straight to "Synchronizing
      // your business data..." with no real connection ever made, before
      // the user had a chance to see or enter the pairing code.
      // `pairedOnce` is the actual correct signal for the one legitimate
      // case (a real 'open' already happened this session, so a
      // reconnect blip - post-pairing restart included - shouldn't bounce
      // back to onboarding) - it's already required by this same clause,
      // so no separate RECONNECTING carve-out is needed at all.
      (!connection.connected && !pairedOnce);

    if (needsOnboarding) {
      phase = 'onboarding';
    } else if (
      !forceContinue &&
      (!sync || sync.syncStatus === 'not_started' || sync.syncStatus === 'in_progress' || sync.syncStatus === 'failed')
    ) {
      phase = 'syncing';
    } else if (!skipOperator && operatorConfigured === false) {
      phase = 'operator-setup';
    } else if (!skipBrandDna && brandDnaComplete === false) {
      // Deliberately AFTER sync, and after operator setup: the adaptive
      // follow-ups are only worth asking once there is a real connected
      // account behind them, and a person who has just scanned a QR is
      // still watching their history arrive. Skippable, and skipping goes
      // straight to the workspace - a brand profile is worth having, never
      // worth blocking someone's inbox for.
      phase = 'brand-dna';
    } else {
      phase = 'workspace';
    }
  }

  return {
    phase,
    connection,
    sync,
    serverUnreachable,
    continueAnyway: () => setForceContinue(true),
    skipOperatorSetup: () => {
      setSkipOperator(true);
      setOperatorConfigured(true);
    },
    /** "I'll do this later" - goes straight to the workspace, and the profile can still be built any time from Settings. */
    skipBrandDna: () => {
      setSkipBrandDna(true);
      setBrandDnaComplete(true);
    },
  };
}
