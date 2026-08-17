import {
  DisconnectReason,
  makeWASocket,
  useMultiFileAuthState,
  type WASocket,
  type WAMessageKey,
} from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import path from 'node:path';
import { rm } from 'node:fs/promises';
import { whatsappMessageIngestionService } from './whatsappMessageIngestionService.js';
import { whatsappSyncService } from './whatsappSyncService.js';
import { enqueueIncomingMessage } from '../queue/queues/incomingMessagesQueue.js';
import {
  enqueueMessageStatus,
  enqueueCallEvent,
  enqueueStatusUpdate,
  enqueueMessageReaction,
  enqueuePresenceUpdate,
} from '../queue/queues/realtimeEventsQueue.js';

const STATUS_BROADCAST_JID = 'status@broadcast';
import { mapBaileysMessageStatus } from '../domain/whatsapp/messageStatus.js';
import { classifyJid, derivePhoneNumber } from '../domain/whatsapp/jid.js';
import { pool } from '../db/pool.js';
import { ensureDefaultBusinessProvisioned } from './businessBootstrapService.js';
import { syncAccountProfilePicture } from './profilePictureSyncService.js';
import { WhatsAppAccountRepository } from '../repositories/whatsappAccountRepository.js';
import { WhatsAppConnectionEventRepository } from '../repositories/whatsappConnectionEventRepository.js';

export type WhatsAppConnectionStatus =
  | 'DISCONNECTED'
  | 'CONNECTING'
  | 'QR_READY'
  | 'CONNECTED'
  | 'RECONNECTING'
  | 'LOGGED_OUT'
  | 'ERROR';

export interface WhatsAppConnectionSnapshot {
  status: WhatsAppConnectionStatus;
  connected: boolean;
  qrAvailable: boolean;
  qrDataUrl: string | null;
  phoneNumber: string | null;
  jid: string | null;
  pushName: string | null;
  connectedAt: string | null;
  lastDisconnectAt: string | null;
  lastError: string | null;
  reconnectAttempt: number;
  /** This account's own real, downloaded profile picture media row - null until a sync has actually succeeded. */
  avatarMediaId: string | null;
}

const DEFAULT_SESSION_DIR = path.resolve(
  process.env.WHATSAPP_SESSION_DIR ?? '.data/whatsapp/primary',
);

export class WhatsAppConnectionService {
  private socket: WASocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;
  private listenersAttached = false;
  private businessId: string | null = null;
  private persistedAccountId: string | null = null;
  private readonly accountRepository = new WhatsAppAccountRepository(pool);
  private readonly connectionEventRepository = new WhatsAppConnectionEventRepository(pool);
  private snapshot: WhatsAppConnectionSnapshot = {
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
    avatarMediaId: null,
  };

  getSnapshot(): WhatsAppConnectionSnapshot {
    return { ...this.snapshot };
  }

  getSocket(): WASocket | null {
    return this.socket;
  }

  /** The persisted tenant/account this live session is writing to, once the account is connected. */
  getPersistedContext(): { businessId: string; whatsappAccountId: string } | null {
    if (!this.businessId || !this.persistedAccountId) return null;
    return { businessId: this.businessId, whatsappAccountId: this.persistedAccountId };
  }

  isReady(): boolean {
    return Boolean(
      this.socket &&
        this.snapshot.status === 'CONNECTED' &&
        this.socket.user?.id,
    );
  }

  /**
   * WhatsApp does not push a contact's live presence or status updates to a
   * connected device by default - real clients only start receiving them
   * for a JID once they explicitly subscribe (the same protocol action the
   * official app performs when a human opens that chat/profile). Without
   * this, presence.update almost never fires and status@broadcast messages
   * for a contact are effectively invisible even though the account is
   * otherwise fully connected. Called when a human actually opens a chat,
   * not blindly for every known contact - mirrors real usage instead of
   * subscribing to hundreds of JIDs at once, which would look nothing like
   * genuine client behavior.
   */
  async subscribePresence(jid: string): Promise<void> {
    if (!this.isReady() || !this.socket) return;
    try {
      await this.socket.presenceSubscribe(jid);
    } catch (error) {
      console.error(`[WhatsApp] Failed to subscribe to presence for ${jid}:`, error);
    }
  }

  /**
   * WhatsApp never pushes a contact's profile picture either - like presence,
   * it exists only behind an explicit per-JID fetch (sock.profilePictureUrl).
   * Returns the real, current CDN URL, or null for the two genuinely
   * indistinguishable-to-us honest cases Baileys collapses into the same
   * error: no photo set, or privacy settings hide it from this account.
   * Never a fabricated/cached URL - always this call's real result.
   */
  async fetchProfilePictureUrl(jid: string): Promise<string | null> {
    if (!this.isReady() || !this.socket) return null;
    try {
      const url = await this.socket.profilePictureUrl(jid, 'image');
      return url ?? null;
    } catch {
      return null;
    }
  }

  /**
   * A real reaction send - `react` is a regular AnyMessageContent variant
   * Baileys accepts via sendMessage, not a separate ad-hoc protocol call.
   * An empty `emoji` string is WhatsApp's own convention for removing a
   * reaction, not a special case this method needs to branch on. Throws
   * (never silently swallowed) so the caller can report a real failure
   * back to the API response rather than pretending it succeeded.
   */
  async sendReaction(key: WAMessageKey, emoji: string): Promise<void> {
    if (!this.isReady() || !this.socket) {
      throw new Error('WhatsApp is not connected');
    }
    await this.socket.sendMessage(key.remoteJid ?? '', { react: { text: emoji, key } });
  }

  async connect(): Promise<WhatsAppConnectionSnapshot> {
    if (this.isReady()) return this.getSnapshot();

    if (
      this.socket &&
      ['CONNECTING', 'QR_READY', 'RECONNECTING'].includes(this.snapshot.status)
    ) {
      return this.getSnapshot();
    }

    this.clearReconnectTimer();
    this.snapshot = {
      ...this.snapshot,
      status: this.reconnectAttempt > 0 ? 'RECONNECTING' : 'CONNECTING',
      connected: false,
      qrAvailable: false,
      qrDataUrl: null,
      lastError: null,
      reconnectAttempt: this.reconnectAttempt,
    };

    const { state, saveCreds } = await useMultiFileAuthState(DEFAULT_SESSION_DIR);

    this.socket = makeWASocket({
      auth: state,
      browser: ['WhatchatAI', 'Chrome', '1.0.0'],
      markOnlineOnConnect: false,
      syncFullHistory: true,
      generateHighQualityLinkPreview: false,
    });

    this.socket.ev.on('creds.update', saveCreds);
    this.attachEventHandlers(this.socket);

    return this.getSnapshot();
  }

  async disconnect(): Promise<void> {
    this.clearReconnectTimer();
    const socket = this.socket;
    this.socket = null;
    this.listenersAttached = false;

    if (socket) {
      try {
        socket.end(undefined);
      } catch (error) {
        this.snapshot = {
          ...this.snapshot,
          lastError: error instanceof Error ? error.message : String(error),
        };
      }
    }

    this.snapshot = {
      ...this.snapshot,
      status: 'DISCONNECTED',
      connected: false,
      qrAvailable: false,
      qrDataUrl: null,
    };
  }

  async logout(): Promise<void> {
    this.clearReconnectTimer();
    const socket = this.socket;
    this.socket = null;
    this.listenersAttached = false;

    if (socket) {
      try {
        await socket.logout();
      } catch (error) {
        this.snapshot = {
          ...this.snapshot,
          lastError: error instanceof Error ? error.message : String(error),
        };
      }
    }

    await this.clearSessionState();

    this.snapshot = {
      ...this.snapshot,
      status: 'LOGGED_OUT',
      connected: false,
      qrAvailable: false,
      qrDataUrl: null,
      phoneNumber: null,
      jid: null,
      pushName: null,
    };
  }

  /**
   * A logged-out WhatsApp session identity can never be resumed - WhatsApp's
   * own servers permanently reject it. Without deleting these credentials,
   * every future connect() attempt keeps trying (and failing) to resume the
   * dead session instead of requesting a genuine new pairing QR, which is
   * why a stale session directory can get an account stuck forever on
   * "Generating a new code..." with no code ever actually appearing.
   */
  private async clearSessionState(): Promise<void> {
    try {
      await rm(DEFAULT_SESSION_DIR, { recursive: true, force: true });
    } catch (error) {
      console.error('[WhatsApp] Failed to clear stale session state:', error);
    }
  }

  private attachEventHandlers(socket: WASocket): void {
    if (this.listenersAttached) return;
    this.listenersAttached = true;

    socket.ev.on('messages.upsert', (payload) => {
      // Speed layer: classify in-memory only (sync, no I/O) and hand off to
      // the incoming_messages queue. No synchronous DB write happens on this
      // event-loop turn - a dedicated worker process persists the message.
      const ingested = whatsappMessageIngestionService.ingestUpsert(payload);
      // status@broadcast is WhatsApp's fixed JID for Status updates, not a
      // real conversation - these get their own table (whatsapp_statuses),
      // never whatsapp_messages/whatsapp_chats.
      const statusUpdates = ingested.filter((message) => message.remoteJid === STATUS_BROADCAST_JID);
      const chatMessages = ingested.filter((message) => message.remoteJid !== STATUS_BROADCAST_JID);
      this.enqueueIngestedMessages(chatMessages);
      this.enqueueStatusUpdates(statusUpdates);
    });

    socket.ev.on('contacts.upsert', (contacts) => {
      this.withSyncContext((businessId, accountId) => {
        void whatsappSyncService.ingestContacts(businessId, accountId, contacts).catch((error) => {
          console.error('[Sync] Failed to ingest contacts.upsert:', error);
        });
      });
    });

    // A saved contact's real name (or LID/phone pairing) can change after
    // the initial sync - without this, a rename on the sender's phone, or a
    // late-arriving verified-business name, never reaches this app.
    socket.ev.on('contacts.update', (contacts) => {
      this.withSyncContext((businessId, accountId) => {
        void whatsappSyncService.ingestContacts(businessId, accountId, contacts).catch((error) => {
          console.error('[Sync] Failed to ingest contacts.update:', error);
        });
      });
    });

    socket.ev.on('chats.upsert', (chats) => {
      this.withSyncContext((businessId, accountId) => {
        void whatsappSyncService.ingestChats(businessId, accountId, chats).catch((error) => {
          console.error('[Sync] Failed to ingest chats.upsert:', error);
        });
      });
    });

    socket.ev.on('groups.upsert', (groups) => {
      this.withSyncContext((businessId, accountId) => {
        void whatsappSyncService.ingestGroups(businessId, accountId, groups).catch((error) => {
          console.error('[Sync] Failed to ingest groups.upsert:', error);
        });
      });
    });

    socket.ev.on('messaging-history.set', (payload) => {
      this.withSyncContext((businessId, accountId, accountJid) => {
        void whatsappSyncService.ingestHistorySet(businessId, accountId, accountJid, payload).catch((error) => {
          console.error('[Sync] Failed to ingest messaging-history.set:', error);
        });
      });
    });

    socket.ev.on('messages.update', (updates) => {
      this.withSyncContext((businessId, accountId) => {
        for (const { key, update } of updates) {
          if (!key.id) continue;
          const status = mapBaileysMessageStatus(update.status);
          if (!status) continue; // Not a status change (e.g. a reaction/edit) - nothing real to record.
          enqueueMessageStatus({ businessId, whatsappAccountId: accountId, whatsappMessageId: key.id, status }).catch(
            (error) => {
              console.error('[WhatsApp] Failed to enqueue message status update', key.id, error);
            },
          );
        }
      });
    });

    socket.ev.on('call', (events) => {
      this.withSyncContext((businessId, accountId) => {
        for (const event of events) {
          enqueueCallEvent({ businessId, whatsappAccountId: accountId, event }).catch((error) => {
            console.error('[WhatsApp] Failed to enqueue call event', event.id, error);
          });
        }
      });
    });

    // Real reaction events - a dedicated Baileys event, not classified via
    // messages.upsert. `key` is the reacted-to message; `reaction.text` is
    // the emoji, falsy when the reaction was removed (Baileys' own doc
    // comment on this event confirms that convention).
    socket.ev.on('messages.reaction', (reactions) => {
      this.withSyncContext((businessId, accountId, accountJid) => {
        for (const { key, reaction } of reactions) {
          if (!key.id) continue;
          enqueueMessageReaction({
            businessId,
            whatsappAccountId: accountId,
            accountJid,
            targetWhatsappMessageId: key.id,
            reaction,
          }).catch((error) => {
            console.error('[WhatsApp] Failed to enqueue message reaction', key.id, error);
          });
        }
      });
    });

    // Real presence events only - never inferred from socket connection state.
    socket.ev.on('presence.update', ({ presences }) => {
      this.withSyncContext((businessId, accountId) => {
        for (const [contactJid, presence] of Object.entries(presences)) {
          enqueuePresenceUpdate({ businessId, whatsappAccountId: accountId, contactJid, presence }).catch((error) => {
            console.error('[WhatsApp] Failed to enqueue presence update', contactJid, error);
          });
        }
      });
    });

    socket.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        try {
          const qrDataUrl = await QRCode.toDataURL(qr, {
            margin: 2,
            width: 320,
            errorCorrectionLevel: 'M',
          });
          this.snapshot = {
            ...this.snapshot,
            status: 'QR_READY',
            connected: false,
            qrAvailable: true,
            qrDataUrl,
            lastError: null,
          };
        } catch (error) {
          this.snapshot = {
            ...this.snapshot,
            status: 'ERROR',
            connected: false,
            qrAvailable: false,
            qrDataUrl: null,
            lastError: error instanceof Error ? error.message : String(error),
          };
        }
      }

      if (connection === 'open') {
        const user = socket.user;
        const jid = user?.id ?? null;
        const jidKind = classifyJid(jid);
        const phoneNumber = jid ? derivePhoneNumber(jid, jidKind, null) : null;
        const pushName = user?.name ?? null;

        this.reconnectAttempt = 0;
        this.snapshot = {
          status: 'CONNECTED',
          connected: true,
          qrAvailable: false,
          qrDataUrl: null,
          phoneNumber,
          jid,
          pushName,
          connectedAt: new Date().toISOString(),
          lastDisconnectAt: null,
          lastError: null,
          reconnectAttempt: 0,
          avatarMediaId: null,
        };

        if (jid) {
          void this.persistConnectedAccount(jid, jidKind, phoneNumber, pushName);
        }
      }

      if (connection === 'close') {
        this.socket = null;
        this.listenersAttached = false;
        this.snapshot = {
          ...this.snapshot,
          status: 'DISCONNECTED',
          connected: false,
          qrAvailable: false,
          qrDataUrl: null,
          lastDisconnectAt: new Date().toISOString(),
          reconnectAttempt: this.reconnectAttempt,
        };

        const code = this.getDisconnectCode(lastDisconnect);
        if (code === DisconnectReason.loggedOut) {
          this.snapshot = { ...this.snapshot, status: 'LOGGED_OUT' };
          this.recordDisconnectEvent('logged_out', 'LOGGED_OUT');
          // The credentials WhatsApp just rejected can never be resumed -
          // without clearing them, every future connect() would keep
          // retrying (and failing) the same dead session instead of
          // requesting a genuine new pairing QR. Reconnecting immediately
          // after, with a clean session, is what actually produces the
          // fresh code the UI promises rather than leaving the account
          // stuck on "Generating a new code..." forever.
          await this.clearSessionState();
          void this.connect().catch((error) => {
            this.snapshot = {
              ...this.snapshot,
              status: 'ERROR',
              lastError: error instanceof Error ? error.message : String(error),
            };
          });
          return;
        }

        this.recordDisconnectEvent('disconnected', 'DISCONNECTED');
        this.scheduleReconnect();
      }
    });
  }

  /**
   * Persists the real connected account so the DB has a genuine tenant/account
   * row to attach contacts, chats, and messages to. A DB outage here must not
   * be reported as a WhatsApp problem - the Baileys connection is still real
   * and open even if this write fails; it's just logged and retried on the
   * next connection event.
   */
  private async persistConnectedAccount(
    jid: string,
    jidKind: ReturnType<typeof classifyJid>,
    phoneNumber: string | null,
    pushName: string | null,
  ): Promise<void> {
    try {
      const business = await ensureDefaultBusinessProvisioned();
      const account = await this.accountRepository.upsertConnected({
        businessId: business.id,
        whatsappJid: jid,
        jidKind,
        phoneNumber,
        pushName,
        connectionStatus: 'CONNECTED',
      });
      this.businessId = business.id;
      this.persistedAccountId = account.id;
      // Reflects whatever's already real in the DB (a prior sync from an
      // earlier connection) - never fabricated, and correctly still null
      // when no photo has ever been fetched for this account.
      this.snapshot = { ...this.snapshot, avatarMediaId: account.profilePictureMediaId };

      await this.connectionEventRepository.record({
        businessId: business.id,
        whatsappAccountId: account.id,
        eventType: 'connected',
        status: 'CONNECTED',
        phoneNumber,
        jid,
        pushName,
      });

      // Best-effort, never blocks the connection itself - "my profile photo"
      // is a real fetch+download, so it can genuinely fail (no photo set,
      // slow network) without that being a connection problem. Once it
      // actually succeeds, reflect the real result in the live snapshot too
      // - but only if this is still the same connected account.
      void syncAccountProfilePicture(business.id, account.id, jid).then(async () => {
        if (this.persistedAccountId !== account.id) return;
        const refreshed = await this.accountRepository.findById(account.id);
        if (refreshed?.profilePictureMediaId) {
          this.snapshot = { ...this.snapshot, avatarMediaId: refreshed.profilePictureMediaId };
        }
      });

      // "initial" sync only ever kicks off once per account, not on every
      // reconnect. A sync abandoned mid-run (dev-server restart, crash)
      // never gets WhatsApp's own completion signal and is reconciled to
      // 'failed' by the stale-sync-job sweep, not left silently 'in_progress'
      // forever - so retrying it here on the next real reconnect is correct.
      if (account.syncStatus === 'not_started' || account.syncStatus === 'failed') {
        await whatsappSyncService.startInitialSync(business.id, account.id);
      }

      await this.syncParticipatingGroups(business.id, account.id);
    } catch (error) {
      console.error('[WhatsApp] Failed to persist connected account:', error);
    }
  }

  /**
   * Baileys' `groups.upsert` event is a delta stream, not a reliable full
   * backfill - an account with real WhatsApp groups could otherwise
   * persist zero of them if that event never fires for pre-existing
   * groups. This explicit fetch is the only way to guarantee the full
   * participating-group list actually lands. Safe on every reconnect:
   * ingestGroups() upserts, so repeats just refresh metadata.
   */
  private async syncParticipatingGroups(businessId: string, accountId: string): Promise<void> {
    if (!this.socket) return;
    try {
      const groups = await this.socket.groupFetchAllParticipating();
      const processed = await whatsappSyncService.ingestGroups(businessId, accountId, Object.values(groups));
      if (processed > 0) {
        console.log(`[WhatsApp] Synced ${processed} participating group(s)`);
      }
    } catch (error) {
      console.error('[WhatsApp] Failed to fetch participating groups:', error);
    }
  }

  /** Runs fn only once the account is actually persisted, so sync events never write against a nonexistent tenant. */
  private withSyncContext(fn: (businessId: string, accountId: string, accountJid: string) => void): void {
    if (!this.businessId || !this.persistedAccountId || !this.snapshot.jid) return;
    fn(this.businessId, this.persistedAccountId, this.snapshot.jid);
  }

  private recordDisconnectEvent(eventType: 'disconnected' | 'logged_out', status: string): void {
    if (!this.businessId || !this.persistedAccountId) return;
    const businessId = this.businessId;
    const accountId = this.persistedAccountId;

    void this.accountRepository.markDisconnected(accountId, status as WhatsAppConnectionStatus).catch((error) => {
      console.error('[WhatsApp] Failed to mark account disconnected:', error);
    });
    void this.connectionEventRepository
      .record({ businessId, whatsappAccountId: accountId, eventType, status })
      .catch((error) => {
        console.error('[WhatsApp] Failed to record disconnect event:', error);
      });
  }

  private enqueueIngestedMessages(ingested: ReturnType<typeof whatsappMessageIngestionService.ingestUpsert>): void {
    if (!this.businessId || !this.persistedAccountId || !this.snapshot.jid) return;
    const businessId = this.businessId;
    const whatsappAccountId = this.persistedAccountId;
    const accountJid = this.snapshot.jid;

    for (const message of ingested) {
      enqueueIncomingMessage({ businessId, whatsappAccountId, accountJid, message }).catch((error) => {
        console.error('[WhatsApp] Failed to enqueue message', message.messageId, error);
      });
    }
  }

  private enqueueStatusUpdates(ingested: ReturnType<typeof whatsappMessageIngestionService.ingestUpsert>): void {
    if (ingested.length === 0) return;
    if (!this.businessId || !this.persistedAccountId) return;
    const businessId = this.businessId;
    const whatsappAccountId = this.persistedAccountId;

    for (const message of ingested) {
      enqueueStatusUpdate({ businessId, whatsappAccountId, ingested: message }).catch((error) => {
        console.error('[WhatsApp] Failed to enqueue status update', message.messageId, error);
      });
    }
  }

  private scheduleReconnect(): void {
    this.clearReconnectTimer();
    this.reconnectAttempt += 1;
    const delay = Math.min(
      1_000 * 2 ** Math.min(this.reconnectAttempt - 1, 5),
      30_000,
    );

    this.snapshot = {
      ...this.snapshot,
      status: 'RECONNECTING',
      connected: false,
      reconnectAttempt: this.reconnectAttempt,
    };

    this.reconnectTimer = setTimeout(() => {
      void this.connect().catch((error) => {
        this.snapshot = {
          ...this.snapshot,
          status: 'ERROR',
          connected: false,
          lastError: error instanceof Error ? error.message : String(error),
        };
        this.scheduleReconnect();
      });
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private getDisconnectCode(lastDisconnect: unknown): number | null {
    const value = lastDisconnect as {
      error?: { output?: { statusCode?: number } };
    } | null;
    return value?.error?.output?.statusCode ?? null;
  }
}

export const whatsappConnectionService = new WhatsAppConnectionService();
