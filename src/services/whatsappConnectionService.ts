import {
  DisconnectReason,
  makeWASocket,
  useMultiFileAuthState,
  type WASocket,
} from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import path from 'node:path';
import { whatsappMessageIngestionService } from './whatsappMessageIngestionService.js';
import { whatsappMessagePersistenceService } from './whatsappMessagePersistenceService.js';
import { classifyJid, derivePhoneNumber } from '../domain/whatsapp/jid.js';
import { pool } from '../db/pool.js';
import { BusinessRepository } from '../repositories/businessRepository.js';
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
  private readonly businessRepository = new BusinessRepository(pool);
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
  };

  getSnapshot(): WhatsAppConnectionSnapshot {
    return { ...this.snapshot };
  }

  getSocket(): WASocket | null {
    return this.socket;
  }

  isReady(): boolean {
    return Boolean(
      this.socket &&
        this.snapshot.status === 'CONNECTED' &&
        this.socket.user?.id,
    );
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

  private attachEventHandlers(socket: WASocket): void {
    if (this.listenersAttached) return;
    this.listenersAttached = true;

    socket.ev.on('messages.upsert', (payload) => {
      const ingested = whatsappMessageIngestionService.ingestUpsert(payload);
      this.persistIngestedMessages(ingested);
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
      const business = await this.businessRepository.ensureDefault();
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

      await this.connectionEventRepository.record({
        businessId: business.id,
        whatsappAccountId: account.id,
        eventType: 'connected',
        status: 'CONNECTED',
        phoneNumber,
        jid,
        pushName,
      });
    } catch (error) {
      console.error('[WhatsApp] Failed to persist connected account:', error);
    }
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

  private persistIngestedMessages(ingested: ReturnType<typeof whatsappMessageIngestionService.ingestUpsert>): void {
    if (!this.businessId || !this.persistedAccountId || !this.snapshot.jid) return;
    const businessId = this.businessId;
    const whatsappAccountId = this.persistedAccountId;
    const accountJid = this.snapshot.jid;

    for (const message of ingested) {
      whatsappMessagePersistenceService
        .persist({ businessId, whatsappAccountId, accountJid, ingested: message })
        .catch((error) => {
          console.error('[WhatsApp] Failed to persist message', message.messageId, error);
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
