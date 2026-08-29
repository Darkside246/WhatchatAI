import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { register } from '../src/services/authService.js';
import { generatePinSalt, hashPin } from '../src/services/operator/operatorCommandService.js';
import { OperatorModeRepository } from '../src/repositories/operatorModeRepository.js';
import { enqueueIncomingMessage, incomingMessagesQueue } from '../src/queue/queues/incomingMessagesQueue.js';
import { realtimeEventsQueue } from '../src/queue/queues/realtimeEventsQueue.js';
import { incomingMessagesWorker, realtimeEventsWorker } from '../src/queue/workers/incomingMessagesWorker.js';
import type { IngestedWhatsAppMessage } from '../src/services/whatsappMessageIngestionService.js';
import { createTestAccount, resetDatabase } from './helpers.js';

const device = { ipAddress: '127.0.0.1', userAgent: 'vitest-agent' };
const ACCOUNT_JID = '12461234567@s.whatsapp.net';

/**
 * Reproduces a real reported symptom: the operator's own personal number IS
 * the connected WhatsApp account (the common solo-owner setup), so they
 * control Operator Mode / the named assistant via WhatsApp's own "Message
 * Yourself" self-chat. Before this fix, needsAiHandoff's !message.fromMe
 * gate (correct for suppressing an AI reply to the app's own echoed
 * outbound sends in a *customer* chat) also silently swallowed this
 * entirely separate self-chat pathway - operatorCommandService.handle()
 * was simply never reached, with no error and no reply.
 */
describe('operator self-chat routing (real BullMQ worker + real Postgres)', () => {
  let businessId: string;
  let accountId: string;

  beforeEach(async () => {
    await resetDatabase();
    const owner = await register(
      { email: 'selfchat-owner@example.com', password: 'correcthorsebatterystaple', displayName: 'Owner' },
      device,
    );
    businessId = owner.business.id;
    // The operator JID equals the connected account's own JID, device suffix
    // and all - exactly the shape Baileys reports for the account's own
    // identity (e.g. "12461234567:21@s.whatsapp.net") on a self-chat send.
    accountId = await createTestAccount(businessId, ACCOUNT_JID);

    const salt = generatePinSalt();
    await new OperatorModeRepository(pool).upsertSettings({
      businessId,
      operatorWaJid: '12461234567:21@s.whatsapp.net',
      pinSalt: salt,
      pinHash: hashPin('1234', salt),
      pinN: 16384,
      pinR: 8,
      pinP: 1,
      enabled: true,
    });
  });

  afterAll(async () => {
    await incomingMessagesWorker.close();
    await realtimeEventsWorker.close();
    await incomingMessagesQueue.close();
    await realtimeEventsQueue.close();
  });

  it('a fromMe message in the self-chat (remoteJid === the connected account) reaches the operator handler and gets a real reply, immediately - not debounced', async () => {
    const messageId = `SELFCHAT-${Date.now()}`;
    const ingested: IngestedWhatsAppMessage = {
      messageId,
      remoteJid: ACCOUNT_JID,
      jidKind: 'individual',
      phoneNumber: '+12461234567',
      participant: null,
      remoteJidAlt: null,
      participantAlt: null,
      fromMe: true,
      pushName: 'Owner',
      isLive: true,
      upsertType: 'notify',
      messageTimestamp: new Date().toISOString(),
      contentType: 'text',
      documentSubtype: null,
      mimetype: null,
      fileName: null,
      textPreview: 'anything',
      mediaDescriptor: null,
      ingestedAt: new Date().toISOString(),
    };

    const completed = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out waiting for worker to process job')), 10_000);
      incomingMessagesWorker.on('completed', function onCompleted(job) {
        if (job.data.message.messageId !== messageId) return;
        clearTimeout(timeout);
        incomingMessagesWorker.off('completed', onCompleted);
        resolve();
      });
      incomingMessagesWorker.on('failed', function onFailed(job, error) {
        if (job?.data.message.messageId !== messageId) return;
        clearTimeout(timeout);
        incomingMessagesWorker.off('failed', onFailed);
        reject(error);
      });
    });

    await enqueueIncomingMessage({ businessId, whatsappAccountId: accountId, accountJid: ACCOUNT_JID, message: ingested });
    await completed;

    // operatorCommandService.handle() reaching its "no active session"
    // branch is the concrete, unambiguous proof this routing fired: it
    // creates a real AWAITING_PIN session row as a side effect - something
    // no other code path in this worker does.
    const session = await new OperatorModeRepository(pool).getActiveSession(businessId);
    expect(session?.status).toBe('AWAITING_PIN');

    const { rows } = await pool.query<{ text_content: string | null }>(
      `SELECT text_content FROM whatsapp_outbound_messages WHERE business_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [businessId],
    );
    expect(rows[0]?.text_content).toContain('PIN');
  }, 15_000);

  it('a fromMe message in a real customer chat (remoteJid !== the connected account) is never treated as an operator command', async () => {
    const messageId = `NOTSELFCHAT-${Date.now()}`;
    const ingested: IngestedWhatsAppMessage = {
      messageId,
      remoteJid: '15550009999@s.whatsapp.net', // a customer, not the account itself
      jidKind: 'individual',
      phoneNumber: '+15550009999',
      participant: null,
      remoteJidAlt: null,
      participantAlt: null,
      fromMe: true, // an agent manually replied to this customer from the linked device
      pushName: 'Owner',
      isLive: true,
      upsertType: 'notify',
      messageTimestamp: new Date().toISOString(),
      contentType: 'text',
      documentSubtype: null,
      mimetype: null,
      fileName: null,
      textPreview: 'sure, see you at 3pm',
      mediaDescriptor: null,
      ingestedAt: new Date().toISOString(),
    };

    const completed = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out waiting for worker to process job')), 10_000);
      incomingMessagesWorker.on('completed', function onCompleted(job) {
        if (job.data.message.messageId !== messageId) return;
        clearTimeout(timeout);
        incomingMessagesWorker.off('completed', onCompleted);
        resolve();
      });
      incomingMessagesWorker.on('failed', function onFailed(job, error) {
        if (job?.data.message.messageId !== messageId) return;
        clearTimeout(timeout);
        incomingMessagesWorker.off('failed', onFailed);
        reject(error);
      });
    });

    await enqueueIncomingMessage({ businessId, whatsappAccountId: accountId, accountJid: ACCOUNT_JID, message: ingested });
    await completed;

    const session = await new OperatorModeRepository(pool).getActiveSession(businessId);
    expect(session).toBeNull();
  }, 15_000);

  /**
   * Reproduces the second, more subtle real symptom: even after the routing
   * fix above, a genuine operator command like "set assistant name to Kai"
   * never reached operatorCommandService.handle() at all - the Tiered
   * Security Sentinel, which exists to catch a customer trying to
   * prompt-inject the AI, ran on this message first and (correctly, for its
   * actual threat model) flagged "instructing the assistant to change its
   * name" as suspicious. A self-chat can never be an external threat - it's
   * the device owner talking to their own number - so it must never be
   * screened as if it might be one. Uses a Stage 1 (static heuristic)
   * trigger here since Stage 2 needs a real Gemini call; the code path that
   * skips runSentinel() doesn't distinguish which stage would have blocked
   * it, so this exercises the same fix.
   */
  it('a self-chat message is never screened by the Sentinel, even when its content would otherwise trip it', async () => {
    const spammyCommand = 'free money, you\'ve won! wire transfer now: https://bit.ly/totally-legit';
    const messageId = `SELFCHAT-SENTINEL-${Date.now()}`;
    const ingested: IngestedWhatsAppMessage = {
      messageId,
      remoteJid: ACCOUNT_JID,
      jidKind: 'individual',
      phoneNumber: '+12461234567',
      participant: null,
      remoteJidAlt: null,
      participantAlt: null,
      fromMe: true,
      pushName: 'Owner',
      isLive: true,
      upsertType: 'notify',
      messageTimestamp: new Date().toISOString(),
      contentType: 'text',
      documentSubtype: null,
      mimetype: null,
      fileName: null,
      textPreview: spammyCommand,
      mediaDescriptor: null,
      ingestedAt: new Date().toISOString(),
    };

    const completed = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out waiting for worker to process job')), 10_000);
      incomingMessagesWorker.on('completed', function onCompleted(job) {
        if (job.data.message.messageId !== messageId) return;
        clearTimeout(timeout);
        incomingMessagesWorker.off('completed', onCompleted);
        resolve();
      });
      incomingMessagesWorker.on('failed', function onFailed(job, error) {
        if (job?.data.message.messageId !== messageId) return;
        clearTimeout(timeout);
        incomingMessagesWorker.off('failed', onFailed);
        reject(error);
      });
    });

    await enqueueIncomingMessage({ businessId, whatsappAccountId: accountId, accountJid: ACCOUNT_JID, message: ingested });
    await completed;

    // Reached operatorCommandService.handle() despite the spammy content -
    // proof the Sentinel never ran for this message.
    const session = await new OperatorModeRepository(pool).getActiveSession(businessId);
    expect(session?.status).toBe('AWAITING_PIN');

    const { rows: audit } = await pool.query(
      `SELECT event_type FROM security_audit_logs WHERE business_id = $1 AND event_type = 'sentinel_heuristic_block'`,
      [businessId],
    );
    expect(audit).toHaveLength(0);
  }, 15_000);

  it('the exact same spammy content sent as a genuine customer message is still blocked by the Sentinel', async () => {
    const spammyCommand = 'free money, you\'ve won! wire transfer now: https://bit.ly/totally-legit';
    const messageId = `CUSTOMER-SENTINEL-${Date.now()}`;
    const ingested: IngestedWhatsAppMessage = {
      messageId,
      remoteJid: '15550008888@s.whatsapp.net', // a real customer, not the self-chat
      jidKind: 'individual',
      phoneNumber: '+15550008888',
      participant: null,
      remoteJidAlt: null,
      participantAlt: null,
      fromMe: false,
      pushName: 'A Customer',
      isLive: true,
      upsertType: 'notify',
      messageTimestamp: new Date().toISOString(),
      contentType: 'text',
      documentSubtype: null,
      mimetype: null,
      fileName: null,
      textPreview: spammyCommand,
      mediaDescriptor: null,
      ingestedAt: new Date().toISOString(),
    };

    const completed = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out waiting for worker to process job')), 10_000);
      incomingMessagesWorker.on('completed', function onCompleted(job) {
        if (job.data.message.messageId !== messageId) return;
        clearTimeout(timeout);
        incomingMessagesWorker.off('completed', onCompleted);
        resolve();
      });
      incomingMessagesWorker.on('failed', function onFailed(job, error) {
        if (job?.data.message.messageId !== messageId) return;
        clearTimeout(timeout);
        incomingMessagesWorker.off('failed', onFailed);
        reject(error);
      });
    });

    await enqueueIncomingMessage({ businessId, whatsappAccountId: accountId, accountJid: ACCOUNT_JID, message: ingested });
    await completed;

    const { rows } = await pool.query('SELECT id FROM whatsapp_messages WHERE business_id = $1 AND whatsapp_message_id = $2', [
      businessId,
      messageId,
    ]);
    expect(rows).toHaveLength(0); // Sentinel blocked it before persistence ever ran.

    const { rows: audit } = await pool.query(
      `SELECT event_type FROM security_audit_logs WHERE business_id = $1 AND event_type = 'sentinel_heuristic_block'`,
      [businessId],
    );
    expect(audit.length).toBeGreaterThan(0);
  }, 15_000);
});
