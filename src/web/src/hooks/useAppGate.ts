import { useEffect, useRef, useState } from 'react';
import { api, type SyncStatusResponse, type WhatsAppConnectionSnapshot } from '../lib/api.js';

export type AppPhase = 'loading' | 'onboarding' | 'syncing' | 'workspace';

export interface AppGateState {
  phase: AppPhase;
  connection: WhatsAppConnectionSnapshot | null;
  sync: SyncStatusResponse | null;
  continueAnyway: () => void;
}

const STATUS_POLL_MS = 2500;
const SYNC_POLL_MS = 2000;

/** Real polling of the real backend - never a simulated/timed transition. */
export function useAppGate(): AppGateState {
  const [connection, setConnection] = useState<WhatsAppConnectionSnapshot | null>(null);
  const [sync, setSync] = useState<SyncStatusResponse | null>(null);
  const [forceContinue, setForceContinue] = useState(false);
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
        if (mounted.current) setConnection(snapshot);
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
    if (!connection?.connected) {
      setSync(null);
      return;
    }

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
  }, [connection?.connected]);

  let phase: AppPhase = 'loading';
  if (connection) {
    if (!connection.connected) {
      phase = 'onboarding';
    } else if (
      !forceContinue &&
      (!sync || sync.syncStatus === 'not_started' || sync.syncStatus === 'in_progress' || sync.syncStatus === 'failed')
    ) {
      phase = 'syncing';
    } else {
      phase = 'workspace';
    }
  }

  return { phase, connection, sync, continueAnyway: () => setForceContinue(true) };
}
