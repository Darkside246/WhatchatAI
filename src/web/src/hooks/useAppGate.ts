import { useEffect, useRef, useState } from 'react';
import { api, type SyncStatusResponse, type WhatsAppConnectionSnapshot } from '../lib/api.js';

export type AppPhase = 'loading' | 'onboarding' | 'syncing' | 'operator-setup' | 'workspace';

export interface AppGateState {
  phase: AppPhase;
  connection: WhatsAppConnectionSnapshot | null;
  sync: SyncStatusResponse | null;
  continueAnyway: () => void;
  skipOperatorSetup: () => void;
}

const STATUS_POLL_MS = 2500;
const SYNC_POLL_MS = 2000;

/** Real polling of the real backend - never a simulated/timed transition. */
export function useAppGate(): AppGateState {
  const [connection, setConnection] = useState<WhatsAppConnectionSnapshot | null>(null);
  const [sync, setSync] = useState<SyncStatusResponse | null>(null);
  const [forceContinue, setForceContinue] = useState(false);
  const [operatorConfigured, setOperatorConfigured] = useState<boolean | null>(null);
  const [skipOperator, setSkipOperator] = useState(false);
  // Baileys drops and auto-reconnects an already-paired session constantly
  // (a near-guaranteed restartRequired right after first pairing, plus
  // transient blips during/after a large history sync). None of that means
  // the account needs re-pairing, so once we've seen a real connection we
  // stop treating momentary disconnects as "show the QR screen again."
  const [pairedOnce, setPairedOnce] = useState(false);
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
      try {
        const snapshot = await api.getWhatsAppStatus();
        if (mounted.current) {
          setConnection(snapshot);
          if (snapshot.connected) setPairedOnce(true);
          if (snapshot.status === 'LOGGED_OUT') setPairedOnce(false);
        }
      } catch {
        // Backend not reachable yet - keep retrying, don't fabricate a status.
      } finally {
        if (mounted.current) timer = setTimeout(poll, STATUS_POLL_MS);
      }
    }

    void poll();
    return () => clearTimeout(timer);
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
      connection.status === 'QR_READY' || connection.status === 'LOGGED_OUT' || (!connection.connected && !pairedOnce);

    if (needsOnboarding) {
      phase = 'onboarding';
    } else if (
      !forceContinue &&
      (!sync || sync.syncStatus === 'not_started' || sync.syncStatus === 'in_progress' || sync.syncStatus === 'failed')
    ) {
      phase = 'syncing';
    } else if (!skipOperator && operatorConfigured === false) {
      phase = 'operator-setup';
    } else {
      phase = 'workspace';
    }
  }

  return {
    phase,
    connection,
    sync,
    continueAnyway: () => setForceContinue(true),
    skipOperatorSetup: () => {
      setSkipOperator(true);
      setOperatorConfigured(true);
    },
  };
}
