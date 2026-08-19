import { useEffect, useRef, useState } from 'react';

// Mirrors src/realtime/pubsub.ts's RealtimeEvent union - the WebSocket
// server forwards every published event verbatim, unfiltered, so this type
// must stay in sync with the backend's or a real event type would compile
// away silently instead of being handled.
export type RealtimeEvent =
  | { type: 'message.new'; businessId: string; chatId: string }
  | { type: 'chat.updated'; businessId: string; chatId: string }
  | { type: 'message.status'; businessId: string; chatId: string; messageId: string; status: string }
  | { type: 'call.updated'; businessId: string; callId: string }
  | { type: 'media.updated'; businessId: string; mediaId: string; messageId: string; chatId: string }
  | { type: 'status.media.updated'; businessId: string; mediaId: string; statusId: string }
  | { type: 'message.reaction'; businessId: string; chatId: string; messageId: string }
  | { type: 'presence.updated'; businessId: string; contactJid: string }
  | { type: 'notification.created'; businessId: string; userId: string; notificationId: string };

export interface WhatsAppSyncState {
  /** The real socket state - never assume live updates are flowing without checking this. */
  connected: boolean;
}

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 15000;

/**
 * Real WebSocket connection to the backend's realtime event bridge
 * (src/realtime). This is a latency improvement over polling, not a
 * replacement for it - callers should keep their existing REST polling as a
 * safety net so the UI never silently goes stale if the socket drops.
 */
export function useWhatsAppSync(onEvent: (event: RealtimeEvent) => void): WhatsAppSyncState {
  const [connected, setConnected] = useState(false);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    let cancelled = false;

    function connect() {
      if (cancelled) return;
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      socket = new WebSocket(`${protocol}//${window.location.host}/ws`);

      socket.onopen = () => {
        attempt = 0;
        setConnected(true);
      };

      socket.onmessage = (event) => {
        try {
          const parsed = JSON.parse(event.data) as { type: string };
          if (parsed.type === 'connected') return;
          onEventRef.current(parsed as RealtimeEvent);
        } catch {
          // Ignore a malformed frame rather than crashing the UI over it.
        }
      };

      socket.onclose = () => {
        setConnected(false);
        if (cancelled) return;
        const delay = Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_MAX_MS);
        attempt += 1;
        reconnectTimer = setTimeout(connect, delay);
      };

      socket.onerror = () => {
        socket?.close();
      };
    }

    connect();
    return () => {
      cancelled = true;
      clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, []);

  return { connected };
}
