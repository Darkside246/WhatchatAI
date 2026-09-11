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
  return {
    ev: new EventEmitter(),
    end: vi.fn(),
    user: undefined,
    waitForSocketOpen: vi.fn().mockResolvedValue(undefined),
    requestPairingCode: vi.fn().mockResolvedValue('ABCD1234'),
  };
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

describe('WhatsAppTenantConnection.requestPhonePairingCode() (real filesystem, real Postgres)', () => {
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

  it('requests a pairing code from Baileys using the digits-only phone number, after waiting for the socket to open', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    cleanupDirs.push(await resolveContainedSessionDir(businessId));

    // Already-normalized E.164 in, as the real caller (the route, via
    // normalizePhoneToE164) always provides - normalization is the
    // route's job, not this class's; it only strips the leading '+'.
    const connection = new WhatsAppTenantConnection(businessId);
    const code = await connection.requestPhonePairingCode('+14155552671');
    expect(code).toBe('ABCD1234');

    const socket = makeWASocketMock.mock.results[0]!.value as {
      waitForSocketOpen: ReturnType<typeof vi.fn>;
      requestPairingCode: ReturnType<typeof vi.fn>;
    };
    expect(socket.requestPairingCode).toHaveBeenCalledWith('14155552671');
    // waitForSocketOpen must be awaited before requestPairingCode is called -
    // Baileys throws "Connection Closed" otherwise if the handshake hasn't
    // finished yet.
    const waitOrder = socket.waitForSocketOpen.mock.invocationCallOrder[0]!;
    const requestOrder = socket.requestPairingCode.mock.invocationCallOrder[0]!;
    expect(waitOrder).toBeLessThan(requestOrder);

    const snapshot = connection.getSnapshot();
    expect(snapshot.status).toBe('PAIRING_CODE_READY');
    expect(snapshot.pairingCode).toBe('ABCD1234');
    expect(snapshot.pairingPhoneNumber).toBe('+14155552671');
  });

  /**
   * Real regression coverage for the guard bug found while adding this
   * feature: requestPairingCode() sets creds.me speculatively and emits
   * creds.update the instant a code is REQUESTED, well before the user
   * ever types it into their phone - at that point Baileys' real
   * `registered` field is still false. The old `if (update?.me)` guard
   * alone would have wrongly treated that as "really paired," permanently
   * disabling the pre-pairing purge for this tenant instance even though
   * no real pairing ever happened.
   */
  it('a requested-but-never-entered phone-pairing code does not disable the pre-pairing purge guard', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const dir = await resolveContainedSessionDir(businessId);
    cleanupDirs.push(dir);

    const connection = new WhatsAppTenantConnection(businessId);
    await connection.requestPhonePairingCode('+14155552671'); // nothing on disk yet - this call's own purge is a no-op

    const socket = makeWASocketMock.mock.results[0]!.value as { ev: EventEmitter };
    // The real shape requestPairingCode() emits pre-completion: `me` set, `registered: false`.
    socket.ev.emit('creds.update', { me: { id: '14155552671:1@s.whatsapp.net' }, registered: false });
    socket.ev.emit('connection.update', { connection: 'close' });
    await new Promise((resolve) => setImmediate(resolve));

    // A leftover file appears - e.g. from a killed process before the code was ever entered.
    await mkdir(dir, { recursive: true });
    const staleFile = path.join(dir, 'creds.json');
    await writeFile(staleFile, '{"corrupt": true');

    // Past the reuse window, so the outstanding code is no longer something
    // to protect - see the pairing-code reuse describe block below, which
    // covers the other half: inside the window the purge must NOT run.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 4 * 60_000);
    try {
      await connection.connect(); // an ordinary reconnect - must still purge, since real pairing never completed
    } finally {
      vi.useRealTimers();
    }

    await expect(access(staleFile)).rejects.toThrow(); // gone - hasPairedThisSession correctly stayed false
  });

  it('a genuine pairing-code completion (registered:true) does disable the purge guard, exactly like a real QR pairing', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const dir = await resolveContainedSessionDir(businessId);
    cleanupDirs.push(dir);
    const realCredsFile = path.join(dir, 'creds.json');

    const connection = new WhatsAppTenantConnection(businessId);
    await connection.requestPhonePairingCode('+14155552671');

    await mkdir(dir, { recursive: true });
    await writeFile(realCredsFile, '{"real": "just-paired creds"}');

    const socket = makeWASocketMock.mock.results[0]!.value as { ev: EventEmitter };
    socket.ev.emit('creds.update', { me: { id: '14155552671:1@s.whatsapp.net' }, registered: true });
    socket.ev.emit('connection.update', { connection: 'close' });
    await new Promise((resolve) => setImmediate(resolve));

    await connection.connect(); // the restart's own connect() - must NOT purge now

    await expect(access(realCredsFile)).resolves.toBeUndefined(); // untouched
  });
});


/**
 * Real regression coverage for "the code generates but the phone says it
 * couldn't link."
 *
 * requestPairingCode() mints a NEW random code on every call, and the code
 * IS the secret the phone derives its key from. Our reconnect path calls
 * connect(lastPairingPhoneNumber), so every socket close during the waiting
 * window silently replaced the code the user was reading off the screen -
 * and the one they then typed had been dead since the moment it was
 * replaced. Baileys accepts an existing code as customPairingCode, so a
 * reconnect inside the window reissues the same one: the server hands back
 * a fresh link_code_pairing_ref, which is the part that actually needed
 * renewing, and the secret on screen keeps working.
 *
 * The other half is the ceiling. The reconnect loop is unbounded, so an
 * abandoned pairing screen used to ask WhatsApp for a brand new code every
 * few seconds indefinitely - which is how a number reaches `rate-overlimit`
 * (429) and stops being pairable at all, long after the browser tab is
 * closed.
 */
describe('WhatsAppTenantConnection - pairing code reuse across reconnects', () => {
  beforeEach(() => {
    makeWASocketMock.mockReset();
    makeWASocketMock.mockReturnValue(fakeSocket());
  });

  const cleanupDirs: string[] = [];
  afterEach(async () => {
    vi.useRealTimers();
    for (const dir of cleanupDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reissues the code already on screen when a reconnect lands inside the window', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    cleanupDirs.push(await resolveContainedSessionDir(businessId));

    const connection = new WhatsAppTenantConnection(businessId);
    await connection.requestPhonePairingCode('+14155552671');
    await connection.connect('+14155552671'); // what a reconnect during the window does

    const socket = makeWASocketMock.mock.results[0]!.value as { requestPairingCode: ReturnType<typeof vi.fn> };
    expect(socket.requestPairingCode.mock.calls).toEqual([
      ['14155552671'], // first request - no code exists yet
      ['14155552671', 'ABCD1234'], // the reconnect - the SAME code, handed back to Baileys
    ]);
    expect(connection.getSnapshot().pairingCode).toBe('ABCD1234');
  });

  it('does not restart the displayed code\u2019s clock when it is reissued', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    cleanupDirs.push(await resolveContainedSessionDir(businessId));

    const connection = new WhatsAppTenantConnection(businessId);
    await connection.requestPhonePairingCode('+14155552671');
    const issuedAt = connection.getSnapshot().pairingCodeGeneratedAt;

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 60_000);
    await connection.connect('+14155552671');
    vi.useRealTimers();

    // Same code, same age. Restarting the countdown here would promise the
    // user a full fresh window for a secret the server may retire first.
    expect(connection.getSnapshot().pairingCodeGeneratedAt).toBe(issuedAt);
  });

  it('does not purge the session directory while a code is still live', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const dir = await resolveContainedSessionDir(businessId);
    cleanupDirs.push(dir);

    const connection = new WhatsAppTenantConnection(businessId);
    await connection.requestPhonePairingCode('+14155552671');

    // The key material the displayed code is a secret for. Purging this
    // mid-window is self-inflicted: it destroys the thing the code the user
    // is typing was derived against.
    await mkdir(dir, { recursive: true });
    const pairingKeys = path.join(dir, 'creds.json');
    await writeFile(pairingKeys, '{"pairingEphemeralKeyPair": "live"}');

    await connection.connect('+14155552671');

    await expect(access(pairingKeys)).resolves.toBeUndefined(); // untouched
  });

  it('mints a genuinely new code once the window has passed', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    cleanupDirs.push(await resolveContainedSessionDir(businessId));

    const connection = new WhatsAppTenantConnection(businessId);
    await connection.requestPhonePairingCode('+14155552671');

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 4 * 60_000);
    await connection.connect('+14155552671');
    vi.useRealTimers();

    const socket = makeWASocketMock.mock.results[0]!.value as { requestPairingCode: ReturnType<typeof vi.fn> };
    // No second argument: an expired code must not be handed back, or the
    // user would be shown a dead secret forever.
    expect(socket.requestPairingCode.mock.calls[1]).toEqual(['14155552671']);
  });

  it('stops asking WhatsApp for codes once the one it issued has expired', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    cleanupDirs.push(await resolveContainedSessionDir(businessId));

    const connection = new WhatsAppTenantConnection(businessId);
    await connection.requestPhonePairingCode('+14155552671');

    // Date is faked, timers are not - the real reconnect backoff still runs.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 4 * 60_000);

    const socket = makeWASocketMock.mock.results[0]!.value as {
      ev: EventEmitter;
      requestPairingCode: ReturnType<typeof vi.fn>;
    };
    socket.ev.emit('connection.update', { connection: 'close' });
    // First backoff step is ~1s plus jitter; this waits past it so the
    // reconnect genuinely fires rather than being asserted before it runs.
    await new Promise((resolve) => setTimeout(resolve, 1_800));
    vi.useRealTimers();

    expect(socket.requestPairingCode).toHaveBeenCalledTimes(1);
    const snapshot = connection.getSnapshot();
    expect(snapshot.pairingCode).toBeNull();
    expect(snapshot.lastError).toContain('expired');
  }, 10_000);
});
