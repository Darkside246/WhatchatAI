import type { WASocket, WAMessageKey } from '@whiskeysockets/baileys';
import { pool } from '../db/pool.js';
import { WhatsAppAccountRepository } from '../repositories/whatsappAccountRepository.js';
import { WhatsAppTenantConnection, type WhatsAppConnectionSnapshot } from './whatsappTenantConnection.js';
import type { IngestedWhatsAppMessage, WhatsAppIngestionStats, WhatsAppMessageIngestionService } from './whatsappMessageIngestionService.js';

/**
 * The subset of WhatsAppTenantConnection's public API the manager actually
 * depends on - WhatsAppTenantConnection satisfies this structurally (no
 * explicit `implements` needed). Exists so tests can inject a fake tenant
 * factory (same constructor-injection pattern OpenClawCellService already
 * uses for its runtime) instead of opening a real Baileys socket just to
 * exercise the manager's own bookkeeping (getOrCreate idempotency, the
 * capacity ceiling, reconnectAllPersisted's chunking/error isolation).
 */
export interface WhatsAppTenantConnectionHandle {
  getSnapshot(): WhatsAppConnectionSnapshot;
  getSocket(): WASocket | null;
  getPersistedContext(): { businessId: string; whatsappAccountId: string } | null;
  isReady(): boolean;
  subscribePresence(jid: string): Promise<void>;
  fetchProfilePictureUrl(jid: string): Promise<string | null>;
  resolvePhoneNumberForLid(lidJid: string): Promise<string | null>;
  updateOwnProfilePicture(imageBuffer: Buffer): Promise<void>;
  sendReaction(key: WAMessageKey, emoji: string): Promise<void>;
  getIngestionService(): WhatsAppMessageIngestionService;
  connect(): Promise<WhatsAppConnectionSnapshot>;
  disconnect(): Promise<void>;
  logout(): Promise<void>;
  requestPhonePairingCode(phoneNumber: string): Promise<string>;
}

const DEFAULT_SNAPSHOT: WhatsAppConnectionSnapshot = {
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
  pairingCode: null,
  pairingCodeGeneratedAt: null,
  pairingPhoneNumber: null,
};

const EMPTY_INGESTION_STATS: WhatsAppIngestionStats = {
  bufferedCount: 0,
  liveCount: 0,
  historicalCount: 0,
  byContentType: {
    text: 0, image: 0, video: 0, voice_note: 0, audio: 0, document: 0, sticker: 0,
    location: 0, contact: 0, contacts: 0, reaction: 0, poll: 0, poll_response: 0,
    button: 0, interactive: 0, system: 0, unsupported: 0,
  },
};

/** A genuinely new tenant is refused past this ceiling; an already-tracked tenant reconnecting never is - see canProvisionNewTenant(). */
const MAX_CONCURRENT_CONNECTIONS = Number(process.env.WHATSAPP_MAX_CONCURRENT_CONNECTIONS ?? 50);
/** Boot-time reconnection batch size - caps how many Baileys sockets open at once during a cold start with many tenants. */
const BOOT_RECONNECT_CONCURRENCY = Number(process.env.WHATSAPP_BOOT_RECONNECT_CONCURRENCY ?? 5);

/**
 * One process, one Map<businessId, connection> - each business's Baileys
 * socket, session directory, and message-ingestion buffer are fully
 * independent WhatsAppTenantConnection instances. Read-only lookups
 * (getSnapshot/isReady/getSocket/getPersistedContext/etc.) for a business
 * with no tracked connection return a safe DISCONNECTED-shaped default
 * rather than allocating a new instance as a side effect of a status check
 * - only connect() (directly, or via reconnectAllPersisted()) ever creates
 * one.
 */
export class WhatsAppConnectionManager {
  private readonly tenants = new Map<string, WhatsAppTenantConnectionHandle>();

  constructor(
    private readonly accountRepository: Pick<WhatsAppAccountRepository, 'listReconnectableBusinesses'> = new WhatsAppAccountRepository(pool),
    private readonly createTenant: (businessId: string) => WhatsAppTenantConnectionHandle = (businessId) =>
      new WhatsAppTenantConnection(businessId),
  ) {}

  private get(businessId: string): WhatsAppTenantConnectionHandle | undefined {
    return this.tenants.get(businessId);
  }

  /** The one idempotency point: returns the already-tracked instance rather than a fresh one that would discard in-flight QR state. */
  private getOrCreate(businessId: string): WhatsAppTenantConnectionHandle {
    let tenant = this.tenants.get(businessId);
    if (!tenant) {
      tenant = this.createTenant(businessId);
      this.tenants.set(businessId, tenant);
    }
    return tenant;
  }

  getSnapshot(businessId: string): WhatsAppConnectionSnapshot {
    return this.get(businessId)?.getSnapshot() ?? DEFAULT_SNAPSHOT;
  }

  getSocket(businessId: string): WASocket | null {
    return this.get(businessId)?.getSocket() ?? null;
  }

  getPersistedContext(businessId: string): { businessId: string; whatsappAccountId: string } | null {
    return this.get(businessId)?.getPersistedContext() ?? null;
  }

  isReady(businessId: string): boolean {
    return this.get(businessId)?.isReady() ?? false;
  }

  async subscribePresence(businessId: string, jid: string): Promise<void> {
    await this.get(businessId)?.subscribePresence(jid);
  }

  async fetchProfilePictureUrl(businessId: string, jid: string): Promise<string | null> {
    const tenant = this.get(businessId);
    if (!tenant) return null;
    return tenant.fetchProfilePictureUrl(jid);
  }

  async resolvePhoneNumberForLid(businessId: string, lidJid: string): Promise<string | null> {
    const tenant = this.get(businessId);
    if (!tenant) return null;
    return tenant.resolvePhoneNumberForLid(lidJid);
  }

  async updateOwnProfilePicture(businessId: string, imageBuffer: Buffer): Promise<void> {
    const tenant = this.get(businessId);
    if (!tenant) throw new Error('WhatsApp is not connected');
    await tenant.updateOwnProfilePicture(imageBuffer);
  }

  async sendReaction(businessId: string, key: WAMessageKey, emoji: string): Promise<void> {
    const tenant = this.get(businessId);
    if (!tenant) throw new Error('WhatsApp is not connected');
    await tenant.sendReaction(key, emoji);
  }

  /** The tenant-scoped equivalent of the old shared ingestion buffer's read endpoints - empty/zeroed for an untracked business, never another tenant's data. */
  getRecentMessages(businessId: string, limit?: number): IngestedWhatsAppMessage[] {
    return this.get(businessId)?.getIngestionService().getRecent(limit) ?? [];
  }

  getIngestionStats(businessId: string): WhatsAppIngestionStats {
    return this.get(businessId)?.getIngestionService().getStats() ?? EMPTY_INGESTION_STATS;
  }

  async connect(businessId: string): Promise<WhatsAppConnectionSnapshot> {
    const tenant = this.getOrCreate(businessId);
    return tenant.connect();
  }

  async requestPhonePairingCode(businessId: string, phoneNumber: string): Promise<string> {
    const tenant = this.getOrCreate(businessId);
    return tenant.requestPhonePairingCode(phoneNumber);
  }

  async disconnect(businessId: string): Promise<void> {
    await this.get(businessId)?.disconnect();
  }

  async logout(businessId: string): Promise<void> {
    await this.get(businessId)?.logout();
  }

  /** A reconnect of an already-tracked tenant must never be blocked by capacity - only a genuinely new tenant counts against the ceiling. */
  canProvisionNewTenant(businessId: string): boolean {
    if (this.tenants.has(businessId)) return true;
    return this.tenants.size < MAX_CONCURRENT_CONNECTIONS;
  }

  /** Every tenant this process is tracking at all, regardless of current live status. */
  activeTenantCount(): number {
    return this.tenants.size;
  }

  /** Only tenants whose socket is genuinely CONNECTED right now - a real subset of activeTenantCount(). */
  connectedTenantCount(): number {
    let count = 0;
    for (const tenant of this.tenants.values()) {
      if (tenant.isReady()) count += 1;
    }
    return count;
  }

  /**
   * Boot-time reconnection: finds every business with a real, previously-
   * connected (never logged-out) WhatsApp account and reconnects it,
   * chunked so a fleet of many tenants doesn't open hundreds of
   * simultaneous Baileys sockets at once. Promise.allSettled per chunk
   * means one tenant's failure never blocks or fails the rest of the
   * batch.
   */
  async reconnectAllPersisted(): Promise<void> {
    const businessIds = await this.accountRepository.listReconnectableBusinesses();
    for (let i = 0; i < businessIds.length; i += BOOT_RECONNECT_CONCURRENCY) {
      const batch = businessIds.slice(i, i + BOOT_RECONNECT_CONCURRENCY);
      await Promise.allSettled(
        batch.map(async (businessId) => {
          try {
            await this.connect(businessId);
          } catch (error) {
            console.error(`[WhatsAppConnectionManager] Failed to reconnect business ${businessId}:`, error);
          }
        }),
      );
    }
  }
}

export const whatsappConnectionManager = new WhatsAppConnectionManager();
