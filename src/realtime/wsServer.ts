import type { Server as HttpServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { subscribeToRealtimeEvents, type RealtimeEvent } from './pubsub.js';

const WS_PATH = '/ws';

/**
 * Real-time push for the workspace UI. No per-business auth scoping yet -
 * this mirrors the rest of the app's current single-default-business
 * behavior (see BusinessRepository.ensureDefault()); every connected client
 * receives every event, same as the REST endpoints today.
 */
export function attachWebSocketServer(server: HttpServer): void {
  const wss = new WebSocketServer({ server, path: WS_PATH });

  wss.on('connection', (socket) => {
    socket.send(JSON.stringify({ type: 'connected' }));
  });

  wss.on('error', (error: Error) => {
    console.error('[Realtime] WebSocket server error:', error.message);
  });

  const unsubscribe = subscribeToRealtimeEvents((event: RealtimeEvent) => {
    const payload = JSON.stringify(event);
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(payload);
    }
  });

  server.on('close', unsubscribe);

  console.log(`[Realtime] WebSocket server attached at ${WS_PATH}`);
}
