import {
  DisconnectReason,
  makeWASocket,
  useMultiFileAuthState,
  type WASocket,
} from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import path from 'node:path';
import { whatsappMessageIngestionService } from './whatsappMessageIngestionService.js';

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
      whatsappMessageIngestionService.ingestUpsert(payload);
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
        const phoneNumber = jid ? this.phoneFromJid(jid) : null;

        this.reconnectAttempt = 0;
        this.snapshot = {
          status: 'CONNECTED',
          connected: true,
          qrAvailable: false,
          qrDataUrl: null,
          phoneNumber,
          jid,
          pushName: user?.name ?? null,
          connectedAt: new Date().toISOString(),
          lastDisconnectAt: null,
          lastError: null,
          reconnectAttempt: 0,
        };
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
          return;
        }

        this.scheduleReconnect();
      }
    });
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

  private phoneFromJid(jid: string): string | null {
    const local = jid.split('@', 1)[0] ?? '';
    const digits = local.replace(/\D/g, '');
    return digits ? `+${digits}` : null;
  }
}

export const whatsappConnectionService = new WhatsAppConnectionService();
