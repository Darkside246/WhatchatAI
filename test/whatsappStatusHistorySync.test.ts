import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { readdir, rm } from 'node:fs/promises';
import { pool } from '../src/db/pool.js';
import { WhatsAppSyncService } from '../src/services/whatsappSyncService.js';
import { WhatsAppStatusRepository } from '../src/repositories/whatsappStatusRepository.js';
import { WhatsAppMessageRepository } from '../src/repositories/whatsappMessageRepository.js';
import { WhatsAppChatRepository } from '../src/repositories/whatsappChatRepository.js';
import { realtimeEventsWorker, incomingMessagesWorker } from '../src/queue/workers/incomingMessagesWorker.js';
import { realtimeEventsQueue } from '../src/queue/queues/realtimeEventsQueue.js';
import { incomingMessagesQueue } from '../src/queue/queues/incomingMessagesQueue.js';
import { createTestAccount, createTestBusiness, resetDatabase } from './helpers.js';

const MEDIA_STORAGE_DIR = path.resolve(process.env.MEDIA_STORAGE_DIR ?? './data/media-storage');

/**
 * Phase 1: closes the defect docs/PHASE_0_MASTER_DIRECTIVE_AUDIT.md
 * root-caused - historical status@broadcast messages (delivered via
 * Baileys' messaging-history.set, the event carrying a business's
 * already-active Statuses at pairing time) previously had no split from
 * ordinary chat messages in ingestHistoryMessages and were silently
 * misfiled into whatsapp_messages/whatsapp_chats instead of
 * whatsapp_statuses. See docs/PHASE_1_STATUS_TEXT_FIX_PROPOSAL.md.
 */
describe('WhatsAppSyncService.ingestHistoryMessages - status@broadcast routing (real Postgres)', () => {
  let businessId: string;
  let accountId: string;
  let sync: WhatsAppSyncService;
  const accountJid = '15550001111@s.whatsapp.net';

  beforeEach(async () => {
    await resetDatabase();
    businessId = await createTestBusiness();
    accountId = await createTestAccount(businessId, accountJid);
    sync = new WhatsAppSyncService();
  });

  afterAll(async () => {
    await realtimeEventsWorker.close();
    await incomingMessagesWorker.close();
    await realtimeEventsQueue.close();
    await incomingMessagesQueue.close();
    if (businessId) await rm(path.join(MEDIA_STORAGE_DIR, businessId), { recursive: true, force: true });
  });

  it('1. a historical text status@broadcast message produces a real row in whatsapp_statuses with the correct text/type', async () => {
    const statusId = `HIST-STATUS-${Date.now()}`;
    const postedAtSeconds = Math.floor(Date.now() / 1000);

    await sync.ingestHistorySet(businessId, accountId, accountJid, {
      chats: [],
      contacts: [],
      messages: [
        {
          key: { remoteJid: 'status@broadcast', id: statusId, fromMe: false, participant: '15550009999@s.whatsapp.net' },
          message: { conversation: 'Already-active status from before pairing' },
          messageTimestamp: postedAtSeconds,
        } as never,
      ],
      progress: 100,
      isLatest: true,
    });

    const statusRepository = new WhatsAppStatusRepository(pool);
    const statuses = await statusRepository.listByAccount(businessId, accountId);
    expect(statuses).toHaveLength(1);
    expect(statuses[0]?.statusId).toBe(statusId);
    expect(statuses[0]?.statusType).toBe('text');
    expect(statuses[0]?.textContent).toBe('Already-active status from before pairing');
    expect(statuses[0]?.publisherJid).toBe('15550009999@s.whatsapp.net');
  });

  it('2. a historical status@broadcast message never appears in whatsapp_chats or whatsapp_messages - the exact regression this fix closes', async () => {
    const statusId = `HIST-STATUS-NOLEAK-${Date.now()}`;

    await sync.ingestHistorySet(businessId, accountId, accountJid, {
      chats: [],
      contacts: [],
      messages: [
        {
          key: { remoteJid: 'status@broadcast', id: statusId, fromMe: false, participant: '15550009999@s.whatsapp.net' },
          message: { conversation: 'Must never become a phantom chat message' },
          messageTimestamp: Math.floor(Date.now() / 1000),
        } as never,
      ],
      progress: 100,
      isLatest: true,
    });

    const messageRepository = new WhatsAppMessageRepository(pool);
    const asMessage = await messageRepository.findByWhatsAppId(businessId, accountId, statusId);
    expect(asMessage).toBeNull();

    const chatRepository = new WhatsAppChatRepository(pool);
    const phantomChat = await chatRepository.findByJid(businessId, accountId, 'status@broadcast');
    expect(phantomChat).toBeNull();
  });

  it('3. a duplicate history-set replay of the same status never creates a second row (real Baileys resend behavior)', async () => {
    const statusId = `HIST-STATUS-REPLAY-${Date.now()}`;
    const batch = {
      chats: [],
      contacts: [],
      messages: [
        {
          key: { remoteJid: 'status@broadcast', id: statusId, fromMe: false, participant: '15550009999@s.whatsapp.net' },
          message: { conversation: 'Replayed batch content' },
          messageTimestamp: Math.floor(Date.now() / 1000),
        } as never,
      ],
      progress: 100,
      isLatest: true,
    };

    const first = await sync.ingestHistoryMessages(businessId, accountId, accountJid, batch.messages);
    const second = await sync.ingestHistoryMessages(businessId, accountId, accountJid, batch.messages);
    expect(first.processed).toBe(1);
    expect(first.failed).toBe(0);
    // The second call still "processes" the status (persistStatusUpdate
    // completes without throwing - it just no-ops past the ON CONFLICT),
    // so it must not count as a failure either.
    expect(second.failed).toBe(0);

    const statusRepository = new WhatsAppStatusRepository(pool);
    const statuses = await statusRepository.listByAccount(businessId, accountId);
    expect(statuses).toHaveLength(1);
  });

  it('4. a historical status with media creates the media placeholder row and enqueues exactly one real download job', async () => {
    const statusId = `HIST-STATUS-MEDIA-${Date.now()}`;

    const completion = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out waiting for historical status media-download job')), 30_000);
      realtimeEventsWorker.on('completed', function onCompleted(job) {
        if (job.name !== 'media-download') return;
        clearTimeout(timeout);
        realtimeEventsWorker.off('completed', onCompleted);
        resolve();
      });
    });

    // Raw WAMessage shape - whatsappMessageIngestionService's own
    // classifyContent/encodeBuffersForQueue does the real encoding, same
    // as the existing live-status and chat-history test fixtures.
    await sync.ingestHistorySet(businessId, accountId, accountJid, {
      chats: [],
      contacts: [],
      messages: [
        {
          key: { remoteJid: 'status@broadcast', id: statusId, fromMe: false, participant: '15550009999@s.whatsapp.net' },
          message: {
            imageMessage: {
              url: 'https://mmg.whatsapp.net/v/t62.7118-24/nonexistent-history-status-media',
              directPath: '/v/t62.7118-24/nonexistent-history-status-media',
              mimetype: 'image/jpeg',
              mediaKey: randomBytes(32),
              fileEncSha256: randomBytes(32),
              fileSha256: randomBytes(32),
              fileLength: 12345,
            },
          },
          messageTimestamp: Math.floor(Date.now() / 1000),
        } as never,
      ],
      progress: 100,
      isLatest: true,
    });

    await completion;

    const statusRepository = new WhatsAppStatusRepository(pool);
    const [status] = await statusRepository.listByAccount(businessId, accountId);
    expect(status?.mediaId).not.toBeNull();
    // Real, honest outcome only - the URL is fake, so this can never be a fabricated success.
    const { rows } = await pool.query<{ download_status: string; status_id: string | null }>(
      'SELECT download_status, status_id FROM whatsapp_media WHERE id = $1',
      [status!.mediaId],
    );
    expect(rows[0]?.status_id).toBe(status!.id);
    expect(['failed', 'unavailable']).toContain(rows[0]?.download_status);
  }, 35_000);

  it('5. a history-set batch for Business A never creates a status attributable to Business B', async () => {
    const otherBusinessId = await createTestBusiness('Other Business');
    const otherAccountId = await createTestAccount(otherBusinessId, '15550002222@s.whatsapp.net');
    const otherSync = new WhatsAppSyncService();

    const statusId = `HIST-STATUS-TENANT-${Date.now()}`;
    await sync.ingestHistorySet(businessId, accountId, accountJid, {
      chats: [],
      contacts: [],
      messages: [
        {
          key: { remoteJid: 'status@broadcast', id: statusId, fromMe: false, participant: '15550009999@s.whatsapp.net' },
          message: { conversation: 'Business A only' },
          messageTimestamp: Math.floor(Date.now() / 1000),
        } as never,
      ],
      progress: 100,
      isLatest: true,
    });

    const statusRepository = new WhatsAppStatusRepository(pool);
    const businessAStatuses = await statusRepository.listByAccount(businessId, accountId);
    const businessBStatuses = await statusRepository.listByAccount(otherBusinessId, otherAccountId);
    expect(businessAStatuses).toHaveLength(1);
    expect(businessBStatuses).toEqual([]);
    void otherSync;
  });
});
