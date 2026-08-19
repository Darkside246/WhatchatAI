import type { Server as HttpServer, IncomingMessage } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { subscribeToRealtimeEvents, type RealtimeEvent } from './pubsub.js';
import { parseCookies } from '../server/cookies.js';
import { SESSION_COOKIE_NAME } from '../server/authMiddleware.js';
import { validateSession } from '../services/authService.js';

const WS_PATH = '/ws';

interface AuthenticatedSocket extends WebSocket {
  wcBusinessId?: string;
  wcUserId?: string;
}

function eventMatchesSocket(event: RealtimeEvent, socket: AuthenticatedSocket): boolean {
  if (event.businessId !== socket.wcBusinessId) return false;
  if (event.type === 'notification.created' && event.userId !== socket.wcUserId) return false;
  return true;
}

/**
 * Real-time push for the workspace UI. Every connection must present a
 * valid session cookie during the handshake (browsers send cookies on the
 * WebSocket upgrade request automatically for same-origin connections, the
 * same way they do for a normal fetch) - a connection with no cookie, or an
 * expired/revoked one, is closed immediately. Events are then only
 * forwarded to sockets whose authenticated business (and, for
 * notifications, user) actually matches - not broadcast to every client
 * regardless of who they are, which is what this used to do.
 */
export function attachWebSocketServer(server: HttpServer): void {
  const wss = new WebSocketServer({ server, path: WS_PATH });

  wss.on('connection', (socket: AuthenticatedSocket, request: IncomingMessage) => {
    void (async () => {
      const cookies = parseCookies(request.headers.cookie);
      const token = cookies[SESSION_COOKIE_NAME];
      const result = token ? await validateSession(token) : null;
      if (!result) {
        socket.close(4001, 'unauthorized');
        return;
      }
      socket.wcBusinessId = result.membership.businessId;
      socket.wcUserId = result.user.id;
      socket.send(JSON.stringify({ type: 'connected' }));
    })().catch((error: Error) => {
      console.error('[Realtime] WebSocket auth failed:', error.message);
      socket.close(1011, 'internal error');
    });
  });

  wss.on('error', (error: Error) => {
    console.error('[Realtime] WebSocket server error:', error.message);
  });

  const unsubscribe = subscribeToRealtimeEvents((event: RealtimeEvent) => {
    const payload = JSON.stringify(event);
    for (const client of wss.clients) {
      const socket = client as AuthenticatedSocket;
      if (socket.readyState === WebSocket.OPEN && socket.wcBusinessId && eventMatchesSocket(event, socket)) {
        socket.send(payload);
      }
    }
  });

  server.on('close', unsubscribe);

  console.log(`[Realtime] WebSocket server attached at ${WS_PATH}`);
}
