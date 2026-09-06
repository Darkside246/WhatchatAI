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
const { WhatsAppTenantConnection } = await import('../src/services/whatsappTenantConnection.js');

const TEST_BUSINESS_ID = '4b6c1e2a-8f3d-4a1b-9c2e-7d5f6a0b1c3e';

/**
 * A fake Baileys socket carrying a real EventEmitter for `.ev` - Baileys'
 * own BaileysEventEmitter has the same on()/emit() surface this class
 * actually uses (socket.ev.on(...) for every event it listens to).
 * `open`/`close`/other 'open'-path fields (socket.user, etc.) are
 * deliberately omitted from these tests - the conflict-handling scenarios
 * under test never reach the 'open' branch, so recordDisconnectEvent's own
 * persistedAccountId guard means no real Postgres/DB repository call
 * happens in any of them.
 */
function fakeSocket() {
  return { ev: new EventEmitter(), end: vi.fn(), user: undefined };
}

describe('WhatsAppTenantConnection - DisconnectReason.connectionReplaced handling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    makeWASocketMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('auto-retries once (RECONNECTING, a real second socket) on the first connectionReplaced - a transient/self-resolved duplicate must not require manual action', async () => {
    const firstSocket = fakeSocket();
    const secondSocket = fakeSocket();
    makeWASocketMock.mockReturnValueOnce(firstSocket).mockReturnValueOnce(secondSocket);
    const connection = new WhatsAppTenantConnection(TEST_BUSINESS_ID);

    await connection.connect();
    expect(makeWASocketMock).toHaveBeenCalledTimes(1);

    firstSocket.ev.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: DisconnectReason.connectionReplaced } } },
    });
    await vi.waitFor(() => {
      expect(connection.getSnapshot().status).toBe('RECONNECTING');
    });
    expect(connection.getSnapshot().connected).toBe(false);
    // Not yet the terminal, manual-action-required state - this is the one
    // bounded auto-retry, and the workspace gate (useAppGate.ts) never
    // blocks on RECONNECTING the way it does on CONFLICT_REPLACED.
    expect(makeWASocketMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(10_000);
    await vi.waitFor(() => {
      expect(makeWASocketMock).toHaveBeenCalledTimes(2);
    });
  });

  it('stops for real (CONFLICT_REPLACED, no further reconnect) once a SECOND connectionReplaced follows the bounded auto-retry - the genuine ongoing-conflict case', async () => {
    const firstSocket = fakeSocket();
    const secondSocket = fakeSocket();
    makeWASocketMock.mockReturnValueOnce(firstSocket).mockReturnValueOnce(secondSocket);
    const connection = new WhatsAppTenantConnection(TEST_BUSINESS_ID);

    await connection.connect();
    firstSocket.ev.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: DisconnectReason.connectionReplaced } } },
    });
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.waitFor(() => expect(makeWASocketMock).toHaveBeenCalledTimes(2));

    // The retry itself gets replaced again too - a real, ongoing conflict
    // (not a one-off), never having reached a genuinely sustained 'open'.
    secondSocket.ev.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: DisconnectReason.connectionReplaced } } },
    });
    await vi.waitFor(() => {
      expect(connection.getSnapshot().status).toBe('CONFLICT_REPLACED');
    });
    expect(connection.getSnapshot().lastError).toContain('another active connection');

    // Advance well past any possible backoff delay - no third socket for this exhausted retry.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(makeWASocketMock).toHaveBeenCalledTimes(2);
  });

  it('a later, separate connectionReplaced incident gets its own fresh bounded retry once the recovered connection has stayed open long enough to count as genuinely sustained', async () => {
    const firstSocket = fakeSocket();
    const secondSocket = fakeSocket();
    makeWASocketMock.mockReturnValueOnce(firstSocket).mockReturnValueOnce(secondSocket);
    const connection = new WhatsAppTenantConnection(TEST_BUSINESS_ID);

    await connection.connect();
    firstSocket.ev.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: DisconnectReason.connectionReplaced } } },
    });
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.waitFor(() => expect(makeWASocketMock).toHaveBeenCalledTimes(2));

    // The retry reaches a real 'open' and stays there past the sustained-
    // connection window - a genuine recovery, not a flicker.
    secondSocket.ev.emit('connection.update', { connection: 'open' });
    await vi.waitFor(() => expect(connection.getSnapshot().status).toBe('CONNECTED'));
    await vi.advanceTimersByTimeAsync(20_000);
    await vi.advanceTimersByTimeAsync(20_000);

    // A brand-new, later incident - since the bound already reset, this
    // gets its own bounded auto-retry (RECONNECTING) rather than being
    // treated as already exhausted from the earlier, unrelated incident
    // (which would instead go straight to the terminal CONFLICT_REPLACED,
    // exactly as asserted in the "stops for real" test above).
    secondSocket.ev.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: DisconnectReason.connectionReplaced } } },
    });
    await vi.waitFor(() => expect(connection.getSnapshot().status).toBe('RECONNECTING'));
    expect(makeWASocketMock).toHaveBeenCalledTimes(2);
  });

  it('still reconnects normally for an ordinary (non-conflict) disconnect - regression check', async () => {
    const firstSocket = fakeSocket();
    const secondSocket = fakeSocket();
    makeWASocketMock.mockReturnValueOnce(firstSocket).mockReturnValueOnce(secondSocket);
    const connection = new WhatsAppTenantConnection(TEST_BUSINESS_ID);

    await connection.connect();
    expect(makeWASocketMock).toHaveBeenCalledTimes(1);

    // restartRequired (515) - a real, ordinary, retryable Baileys disconnect code.
    firstSocket.ev.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: DisconnectReason.restartRequired } } },
    });
    await vi.waitFor(() => {
      expect(connection.getSnapshot().status).toBe('RECONNECTING');
    });

    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => {
      expect(makeWASocketMock).toHaveBeenCalledTimes(2);
    });
  });

  it('still clears session state and reconnects for loggedOut, but through the same backoff as any other disconnect - regression check', async () => {
    const firstSocket = fakeSocket();
    const secondSocket = fakeSocket();
    makeWASocketMock.mockReturnValueOnce(firstSocket).mockReturnValueOnce(secondSocket);
    const connection = new WhatsAppTenantConnection(TEST_BUSINESS_ID);

    await connection.connect();
    firstSocket.ev.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: DisconnectReason.loggedOut } } },
    });

    // A real, confirmed bug this asserts against: this branch used to call
    // connect() with zero delay, so a session WhatsApp keeps rejecting as
    // loggedOut (e.g. a stale duplicate linked device still holding the
    // real device slot) hammered WhatsApp's servers in a tight loop -
    // reconnecting many times per second and burning through fresh
    // pairing codes/QRs almost as fast as they were issued. No timer
    // advance yet: the second socket must NOT exist before the real
    // backoff delay has elapsed.
    await vi.waitFor(() => {
      expect(connection.getSnapshot().status).toBe('RECONNECTING');
    });
    expect(makeWASocketMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => {
      expect(makeWASocketMock).toHaveBeenCalledTimes(2);
    });
  });

  it('never creates two sockets for the same tenant when connect() is called concurrently - the real ENOENT-crash race', async () => {
    // useMultiFileAuthState is mocked to resolve on a real microtask queue
    // (mockResolvedValue), so both connect() calls genuinely reach their
    // first await before either finishes setup - the exact window that used
    // to let a second call slip past the old this.socket-based guard, since
    // this.socket is only ever assigned after that await.
    const socket = fakeSocket();
    makeWASocketMock.mockReturnValue(socket);
    const connection = new WhatsAppTenantConnection(TEST_BUSINESS_ID);

    await Promise.all([connection.connect(), connection.connect(), connection.connect()]);

    expect(makeWASocketMock).toHaveBeenCalledTimes(1);
  });

  it('never crashes the process when saveCreds() rejects - a tenant credential-save failure stays isolated', async () => {
    const { useMultiFileAuthState } = await import('@whiskeysockets/baileys');
    const rejectingSaveCreds = vi.fn().mockRejectedValue(new Error('ENOENT: session dir missing'));
    vi.mocked(useMultiFileAuthState).mockResolvedValueOnce({ state: {} as never, saveCreds: rejectingSaveCreds });

    const socket = fakeSocket();
    makeWASocketMock.mockReturnValueOnce(socket);
    const connection = new WhatsAppTenantConnection(TEST_BUSINESS_ID);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    await connection.connect();
    // creds.update is emitted synchronously (EventEmitter.emit never awaits
    // listeners) - the old code passed saveCreds directly as the listener,
    // so its rejection became an unhandled promise rejection that this
    // app's own top-level handler treats as FATAL and kills the whole
    // multi-tenant server. Asserting this call itself doesn't throw, and
    // that the rejection was actually caught and logged instead, is the
    // real regression check.
    expect(() => socket.ev.emit('creds.update', {})).not.toThrow();
    await vi.waitFor(() => {
      expect(rejectingSaveCreds).toHaveBeenCalledTimes(1);
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining('Failed to persist credentials'),
        expect.any(Error),
      );
    });

    consoleError.mockRestore();
  });
});
