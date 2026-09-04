import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rm } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { createTestBusiness, resetDatabase } from './helpers.js';

const makeWASocketMock = vi.fn();
vi.mock('@whiskeysockets/baileys', async () => {
  const actual = await vi.importActual<typeof import('@whiskeysockets/baileys')>('@whiskeysockets/baileys');
  return {
    ...actual,
    makeWASocket: (...args: unknown[]) => makeWASocketMock(...args),
    useMultiFileAuthState: vi.fn().mockResolvedValue({ state: {}, saveCreds: vi.fn().mockResolvedValue(undefined) }),
  };
});

const { resolveContainedSessionDir, WhatsAppTenantConnection } = await import('../src/services/whatsappTenantConnection.js');

function fakeSocket() {
  return {
    ev: new EventEmitter(),
    end: vi.fn(),
    user: undefined,
    waitForSocketOpen: vi.fn().mockResolvedValue(undefined),
    requestPairingCode: vi.fn().mockResolvedValue('ABCD1234'),
  };
}

/**
 * Real regression coverage for a confirmed production bug: disconnect()
 * nulls out this.socket and calls socket.end() synchronously, but Baileys
 * still fires a 'close' connection.update on that same (now orphaned)
 * socket's event emitter afterward - the listener was never removed, only
 * this.socket was repointed. Before this fix, that belated event fell
 * through to the same handling a genuine unexpected drop gets:
 * recordDisconnectEvent() (a real logged FK violation - "Key
 * (whatsapp_account_id)=(...) is not present in table whatsapp_accounts" -
 * once account deletion had already removed the row) and scheduleReconnect(),
 * silently reviving a connection the caller had just torn down on purpose.
 */
describe('WhatsAppTenantConnection - stale socket guard on connection.update (real filesystem, real Postgres)', () => {
  beforeEach(() => {
    makeWASocketMock.mockReset();
    makeWASocketMock.mockReturnValue(fakeSocket());
  });

  const cleanupDirs: string[] = [];
  afterEach(async () => {
    for (const dir of cleanupDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('ignores a belated close event from a socket disconnect() already tore down - no reconnect, status stays DISCONNECTED', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    cleanupDirs.push(await resolveContainedSessionDir(businessId));

    const connection = new WhatsAppTenantConnection(businessId);
    await connection.connect();

    const socket = makeWASocketMock.mock.results[0]!.value as { ev: EventEmitter; end: ReturnType<typeof vi.fn> };

    await connection.disconnect();
    expect(socket.end).toHaveBeenCalled();
    expect(connection.getSnapshot().status).toBe('DISCONNECTED');

    // Simulate Baileys firing the real close event on the torn-down socket
    // after end() resolves internally, as it does in production.
    socket.ev.emit('connection.update', { connection: 'close' });
    await new Promise((resolve) => setImmediate(resolve));

    // Must still be DISCONNECTED, not RECONNECTING - proving the stale
    // event never reached scheduleReconnect().
    expect(connection.getSnapshot().status).toBe('DISCONNECTED');
    // makeWASocket only called once - no reconnect socket was ever opened.
    expect(makeWASocketMock).toHaveBeenCalledTimes(1);
  });

  it('ignores a belated close event from a socket a newer connect() has already superseded', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    cleanupDirs.push(await resolveContainedSessionDir(businessId));

    const connection = new WhatsAppTenantConnection(businessId);
    await connection.connect();
    const firstSocket = makeWASocketMock.mock.results[0]!.value as { ev: EventEmitter };

    makeWASocketMock.mockReturnValueOnce(fakeSocket());
    await connection.disconnect();
    await connection.connect(); // a fresh socket now owns this.socket

    expect(makeWASocketMock).toHaveBeenCalledTimes(2);

    // The old socket's belated close must not affect the new connection's state.
    firstSocket.ev.emit('connection.update', { connection: 'close' });
    await new Promise((resolve) => setImmediate(resolve));

    expect(connection.getSnapshot().status).not.toBe('RECONNECTING');
  });
});
