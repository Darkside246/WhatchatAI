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
    useMultiFileAuthState: vi.fn().mockResolvedValue({ state: {}, saveCreds: vi.fn() }),
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
});
