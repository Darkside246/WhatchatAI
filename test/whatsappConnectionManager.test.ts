import { describe, expect, it, vi } from 'vitest';
import type { WAMessageKey } from '@whiskeysockets/baileys';
import {
  WhatsAppConnectionManager,
  type WhatsAppTenantConnectionHandle,
} from '../src/services/whatsappConnectionManager.js';
import type { WhatsAppConnectionSnapshot } from '../src/services/whatsappTenantConnection.js';
import type { WhatsAppMessageIngestionService } from '../src/services/whatsappMessageIngestionService.js';

const DISCONNECTED_SNAPSHOT: WhatsAppConnectionSnapshot = {
  status: 'DISCONNECTED',
  connected: false,
  qrAvailable: false,
  qrDataUrl: null,
  phoneNumber: null,
  jid: null,
  pushName: null,
  connectedAt: null,
  lastDisconnectAt: null,
  lastError: null,
  reconnectAttempt: 0,
  qrGeneratedAt: null,
  avatarMediaId: null,
};

/** A minimal fake tenant, standing in for a real WhatsAppTenantConnection so these tests never open a real Baileys socket. */
function makeFakeTenant(businessId: string, overrides: Partial<WhatsAppTenantConnectionHandle> = {}): WhatsAppTenantConnectionHandle {
  let snapshot: WhatsAppConnectionSnapshot = { ...DISCONNECTED_SNAPSHOT };
  let ready = false;
  return {
    getSnapshot: () => snapshot,
    getSocket: () => null,
    getPersistedContext: () => (ready ? { businessId, whatsappAccountId: `${businessId}-account` } : null),
    isReady: () => ready,
    subscribePresence: vi.fn(async () => {}),
    fetchProfilePictureUrl: vi.fn(async () => null),
    resolvePhoneNumberForLid: vi.fn(async () => null),
    updateOwnProfilePicture: vi.fn(async () => {}),
    sendReaction: vi.fn(async () => {}),
    getIngestionService: () => ({ getRecent: () => [], getStats: () => ({ bufferedCount: 0, liveCount: 0, historicalCount: 0, byContentType: {} }) }) as unknown as WhatsAppMessageIngestionService,
    connect: vi.fn(async () => {
      ready = true;
      snapshot = { ...snapshot, status: 'CONNECTED', connected: true };
      return snapshot;
    }),
    disconnect: vi.fn(async () => {
      ready = false;
      snapshot = { ...snapshot, status: 'DISCONNECTED', connected: false };
    }),
    logout: vi.fn(async () => {
      ready = false;
      snapshot = { ...snapshot, status: 'LOGGED_OUT', connected: false };
    }),
    ...overrides,
  };
}

function makeManager(createTenant: (businessId: string) => WhatsAppTenantConnectionHandle, reconnectable: string[] = []) {
  return new WhatsAppConnectionManager({ listReconnectableBusinesses: async () => reconnectable }, createTenant);
}

describe('WhatsAppConnectionManager (bookkeeping, via a fake tenant factory)', () => {
  it('returns a safe DISCONNECTED default for a business with no tracked connection, without allocating one', () => {
    const factory = vi.fn(makeFakeTenant);
    const manager = makeManager(factory);
    expect(manager.getSnapshot('biz-1')).toEqual(DISCONNECTED_SNAPSHOT);
    expect(manager.isReady('biz-1')).toBe(false);
    expect(manager.getSocket('biz-1')).toBeNull();
    expect(manager.getPersistedContext('biz-1')).toBeNull();
    expect(factory).not.toHaveBeenCalled();
    expect(manager.activeTenantCount()).toBe(0);
  });

  it('connect() is the idempotency point - a second connect() for the same business reuses the tracked instance', async () => {
    const factory = vi.fn(makeFakeTenant);
    const manager = makeManager(factory);

    await manager.connect('biz-1');
    await manager.connect('biz-1');

    expect(factory).toHaveBeenCalledTimes(1);
    expect(manager.activeTenantCount()).toBe(1);
  });

  it('tracks independent state per tenant - two businesses never share a connection', async () => {
    const manager = makeManager(makeFakeTenant);

    await manager.connect('biz-1');
    expect(manager.isReady('biz-1')).toBe(true);
    expect(manager.isReady('biz-2')).toBe(false);

    await manager.connect('biz-2');
    expect(manager.isReady('biz-2')).toBe(true);
    expect(manager.activeTenantCount()).toBe(2);
  });

  it('connectedTenantCount() only counts genuinely ready tenants, not every tracked one', async () => {
    const manager = makeManager(makeFakeTenant);
    await manager.connect('biz-1');
    await manager.connect('biz-2');
    await manager.disconnect('biz-2');

    expect(manager.activeTenantCount()).toBe(2);
    expect(manager.connectedTenantCount()).toBe(1);
  });

  describe('canProvisionNewTenant (capacity ceiling)', () => {
    it('refuses a genuinely new tenant once at the configured ceiling, but never blocks a reconnect of an already-tracked one', async () => {
      const original = process.env.WHATSAPP_MAX_CONCURRENT_CONNECTIONS;
      process.env.WHATSAPP_MAX_CONCURRENT_CONNECTIONS = '2';
      vi.resetModules();
      try {
        const { WhatsAppConnectionManager: FreshManager } = await import('../src/services/whatsappConnectionManager.js');
        const manager = new FreshManager({ listReconnectableBusinesses: async () => [] }, makeFakeTenant);

        await manager.connect('biz-1');
        await manager.connect('biz-2');

        expect(manager.canProvisionNewTenant('biz-3')).toBe(false); // at the ceiling
        expect(manager.canProvisionNewTenant('biz-1')).toBe(true); // already tracked - never blocked
      } finally {
        if (original === undefined) delete process.env.WHATSAPP_MAX_CONCURRENT_CONNECTIONS;
        else process.env.WHATSAPP_MAX_CONCURRENT_CONNECTIONS = original;
        vi.resetModules();
      }
    });

    it('defaults to a generous ceiling that a small tracked count never hits', async () => {
      const manager = makeManager(makeFakeTenant);
      await manager.connect('biz-1');
      await manager.connect('biz-2');
      expect(manager.canProvisionNewTenant('biz-3')).toBe(true);
    });
  });

  describe('reconnectAllPersisted (chunking and error isolation)', () => {
    it('reconnects every business the repository reports as reconnectable', async () => {
      const manager = makeManager(makeFakeTenant, ['biz-1', 'biz-2', 'biz-3']);
      await manager.reconnectAllPersisted();
      expect(manager.activeTenantCount()).toBe(3);
      expect(manager.isReady('biz-1')).toBe(true);
      expect(manager.isReady('biz-2')).toBe(true);
      expect(manager.isReady('biz-3')).toBe(true);
    });

    it('one tenant failing to connect never blocks or fails the rest of the batch', async () => {
      const factory = (businessId: string): WhatsAppTenantConnectionHandle => {
        if (businessId === 'biz-bad') {
          return makeFakeTenant(businessId, {
            connect: vi.fn(async () => {
              throw new Error('simulated connect failure');
            }),
          });
        }
        return makeFakeTenant(businessId);
      };
      const manager = makeManager(factory, ['biz-1', 'biz-bad', 'biz-2']);

      await expect(manager.reconnectAllPersisted()).resolves.toBeUndefined();

      expect(manager.isReady('biz-1')).toBe(true);
      expect(manager.isReady('biz-2')).toBe(true);
      expect(manager.isReady('biz-bad')).toBe(false);
    });
  });

  describe('per-tenant delegation', () => {
    it('sendReaction throws for an untracked business rather than silently no-oping', async () => {
      const manager = makeManager(makeFakeTenant);
      await expect(manager.sendReaction('biz-1', {} as WAMessageKey, '👍')).rejects.toThrow('WhatsApp is not connected');
    });

    it('subscribePresence/fetchProfilePictureUrl/resolvePhoneNumberForLid are safe no-ops for an untracked business', async () => {
      const manager = makeManager(makeFakeTenant);
      await expect(manager.subscribePresence('biz-1', 'jid@s.whatsapp.net')).resolves.toBeUndefined();
      await expect(manager.fetchProfilePictureUrl('biz-1', 'jid@s.whatsapp.net')).resolves.toBeNull();
      await expect(manager.resolvePhoneNumberForLid('biz-1', '123@lid')).resolves.toBeNull();
    });

    it('routes calls to the correct tenant instance only', async () => {
      const manager = makeManager(makeFakeTenant);
      await manager.connect('biz-1');
      await manager.connect('biz-2');

      await manager.subscribePresence('biz-1', 'jid@s.whatsapp.net');

      const tenant1Snapshot = manager.getPersistedContext('biz-1');
      const tenant2Snapshot = manager.getPersistedContext('biz-2');
      expect(tenant1Snapshot?.businessId).toBe('biz-1');
      expect(tenant2Snapshot?.businessId).toBe('biz-2');
    });
  });
});
