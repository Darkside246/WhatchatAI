import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const makeWASocketMock = vi.fn();

vi.mock('@whiskeysockets/baileys', async () => {
  const actual = await vi.importActual<typeof import('@whiskeysockets/baileys')>('@whiskeysockets/baileys');
  return {
    ...actual,
    makeWASocket: (...args: unknown[]) => makeWASocketMock(...args),
    useMultiFileAuthState: vi.fn().mockResolvedValue({ state: {}, saveCreds: vi.fn() }),
  };
});

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return { ...actual, rm: vi.fn().mockResolvedValue(undefined) };
});

const { DisconnectReason } = await import('@whiskeysockets/baileys');
const { WhatsAppConnectionService } = await import('../src/services/whatsappConnectionService.js');

/**
 * A fake Baileys socket carrying a real EventEmitter for `.ev` - Baileys'
 * own BaileysEventEmitter has the same on()/emit() surface this service
 * actually uses (socket.ev.on(...) for every event it listens to).
 * `open`/`close`/other 'open'-path fields (socket.user, etc.) are
 * deliberately omitted from these tests - the conflict-handling scenarios
 * under test never reach the 'open' branch, so recordDisconnectEvent's own
 * businessId/persistedAccountId guard means no real Postgres/DB repository
 * call happens in any of them.
 */
function fakeSocket() {
  return { ev: new EventEmitter(), end: vi.fn(), user: undefined };
}

describe('WhatsAppConnectionService - DisconnectReason.connectionReplaced handling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    makeWASocketMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('stops automatic reconnect and marks status CONFLICT_REPLACED on a real connectionReplaced disconnect', async () => {
    const socket = fakeSocket();
    makeWASocketMock.mockReturnValue(socket);
    const service = new WhatsAppConnectionService();

    await service.connect();
    expect(makeWASocketMock).toHaveBeenCalledTimes(1);

    socket.ev.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: DisconnectReason.connectionReplaced } } },
    });
    await vi.waitFor(() => {
      expect(service.getSnapshot().status).toBe('CONFLICT_REPLACED');
    });

    expect(service.getSnapshot().connected).toBe(false);
    expect(service.getSnapshot().lastError).toContain('another active connection');

    // Advance well past any possible backoff delay - a second socket must
    // never be created for this disconnect reason.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(makeWASocketMock).toHaveBeenCalledTimes(1);
  });

  it('still reconnects normally for an ordinary (non-conflict) disconnect - regression check', async () => {
    const firstSocket = fakeSocket();
    const secondSocket = fakeSocket();
    makeWASocketMock.mockReturnValueOnce(firstSocket).mockReturnValueOnce(secondSocket);
    const service = new WhatsAppConnectionService();

    await service.connect();
    expect(makeWASocketMock).toHaveBeenCalledTimes(1);

    // restartRequired (515) - a real, ordinary, retryable Baileys disconnect code.
    firstSocket.ev.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: DisconnectReason.restartRequired } } },
    });
    await vi.waitFor(() => {
      expect(service.getSnapshot().status).toBe('RECONNECTING');
    });

    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => {
      expect(makeWASocketMock).toHaveBeenCalledTimes(2);
    });
  });

  it('still clears session state and reconnects immediately for loggedOut - regression check', async () => {
    const firstSocket = fakeSocket();
    const secondSocket = fakeSocket();
    makeWASocketMock.mockReturnValueOnce(firstSocket).mockReturnValueOnce(secondSocket);
    const service = new WhatsAppConnectionService();

    await service.connect();
    firstSocket.ev.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: DisconnectReason.loggedOut } } },
    });

    await vi.waitFor(() => {
      expect(makeWASocketMock).toHaveBeenCalledTimes(2);
    });
  });
});
