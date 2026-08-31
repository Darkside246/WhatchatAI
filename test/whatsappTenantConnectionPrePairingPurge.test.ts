import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, rm, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createTestAccount, createTestBusiness, resetDatabase } from './helpers.js';

const makeWASocketMock = vi.fn();
vi.mock('@whiskeysockets/baileys', async () => {
  const actual = await vi.importActual<typeof import('@whiskeysockets/baileys')>('@whiskeysockets/baileys');
  return {
    ...actual,
    makeWASocket: (...args: unknown[]) => makeWASocketMock(...args),
    useMultiFileAuthState: vi.fn().mockResolvedValue({ state: {}, saveCreds: vi.fn().mockResolvedValue(undefined) }),
  };
});

const { resolveContainedSessionDir } = await import('../src/services/whatsappTenantConnection.js');
const { WhatsAppTenantConnection } = await import('../src/services/whatsappTenantConnection.js');

function fakeSocket() {
  return { ev: new EventEmitter(), end: vi.fn(), user: undefined };
}

/**
 * Real regression coverage for the "invalid QR when scanned" bug: a
 * pairing attempt interrupted mid-write (a crash, a killed process) used
 * to leave partial/inconsistent key material on disk that a later
 * connect() attempt for the same, still-never-paired business would
 * silently reuse - producing a QR that looked structurally fine but that
 * WhatsApp's real servers rejected. connect() now purges any leftover
 * session directory first, but only for a business that has never
 * actually completed pairing (no persisted whatsapp_accounts row) -
 * an already-paired business reconnecting after a restart must never
 * have its real, working session wiped.
 */
describe('WhatsAppTenantConnection.connect() - pre-pairing session purge (real filesystem, real Postgres)', () => {
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

  it('deletes a leftover session file before connecting a business that has never paired', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();

    const dir = await resolveContainedSessionDir(businessId);
    cleanupDirs.push(dir);
    await mkdir(dir, { recursive: true });
    const staleFile = path.join(dir, 'creds.json');
    await writeFile(staleFile, '{"corrupt": true'); // deliberately malformed, mimicking a crash mid-write

    const connection = new WhatsAppTenantConnection(businessId);
    await connection.connect();

    await expect(access(staleFile)).rejects.toThrow(); // gone
  });

  it('never touches an existing session for a business that has already paired before', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    await createTestAccount(businessId); // a real, persisted whatsapp_accounts row - "already paired"

    const dir = await resolveContainedSessionDir(businessId);
    cleanupDirs.push(dir);
    await mkdir(dir, { recursive: true });
    const realCredsFile = path.join(dir, 'creds.json');
    await writeFile(realCredsFile, '{"real": "creds"}');

    const connection = new WhatsAppTenantConnection(businessId);
    await connection.connect();

    await expect(access(realCredsFile)).resolves.toBeUndefined(); // untouched
  });

  /**
   * Real regression coverage for the "generates a new QR every time, never
   * actually links" bug: WhatsApp's own multi-device protocol mandates a
   * full connection restart the instant pairing succeeds (Baileys logs this
   * as "pairing configured successfully, expect to restart the
   * connection..."), and that restart's own connect() call lands here with
   * the business still genuinely at zero whatsapp_accounts rows - the row
   * that condition is watching for is only created later, on the 'open'
   * event this exact restart is working towards. Without hasPairedThisSession,
   * the purge above fired on that restart too and deleted the credentials
   * creds.update had just written, so every real pairing attempt destroyed
   * itself one step before completing.
   */
  it('does not purge the session on the restart-required reconnect immediately after a real pairing succeeds, even with no whatsapp_accounts row yet', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();

    const dir = await resolveContainedSessionDir(businessId);
    cleanupDirs.push(dir);
    const realCredsFile = path.join(dir, 'creds.json');

    const connection = new WhatsAppTenantConnection(businessId);
    await connection.connect(); // nothing on disk yet - this connect()'s own purge is a legitimate no-op

    // Only now does real "pairing just happened" data appear on disk - a
    // real saveCreds() would write this the instant creds.update fires,
    // which the mock here doesn't actually do, so it's simulated directly.
    await mkdir(dir, { recursive: true });
    await writeFile(realCredsFile, '{"real": "just-paired creds"}');

    const socket = makeWASocketMock.mock.results[0]!.value as { ev: EventEmitter };
    // The real pairing signal - creds.update firing with `.me` populated -
    // followed by the mandated restart (an ordinary close, not loggedOut or
    // connectionReplaced, exactly like WhatsApp's real "restart required").
    socket.ev.emit('creds.update', { me: { id: 'test-business:1@s.whatsapp.net' } });
    socket.ev.emit('connection.update', { connection: 'close' });
    // connection.update's handler is async; let it actually run (reset
    // this.socket, flip status) before driving the next connect() call.
    await new Promise((resolve) => setImmediate(resolve));

    await connection.connect(); // the restart's own connect() - must NOT purge now

    await expect(access(realCredsFile)).resolves.toBeUndefined(); // untouched
  });
});
