import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { AiAgentRepository } from '../src/repositories/aiAgentRepository.js';
import { WhatsAppMessageRepository } from '../src/repositories/whatsappMessageRepository.js';
import { WhatsAppChatRepository } from '../src/repositories/whatsappChatRepository.js';
import { NotificationRepository } from '../src/repositories/notificationRepository.js';
import { register } from '../src/services/authService.js';
import { enqueueIncomingMessage, incomingMessagesQueue } from '../src/queue/queues/incomingMessagesQueue.js';
import { realtimeEventsQueue } from '../src/queue/queues/realtimeEventsQueue.js';
import { incomingMessagesWorker, realtimeEventsWorker } from '../src/queue/workers/incomingMessagesWorker.js';
import type { IngestedWhatsAppMessage } from '../src/services/whatsappMessageIngestionService.js';
import { createTestAccount, resetDatabase } from './helpers.js';

const device = { ipAddress: '127.0.0.1', userAgent: 'vitest-agent' };

/**
 * This environment has no GEMINI_API_KEY configured (same real state the
 * Sentinel tests assert against) - so these tests exercise the real
 * agent-selection and honest-skip wiring around the AI reply pipeline
 * without a live model call, and assert the one thing that must never
 * happen regardless: no outbound message gets fabricated.
 */
describe('AI reply hand-off (real BullMQ worker + real Postgres, real GEMINI_API_KEY absence in this environment)', () => {
  let businessId: string;
  let ownerId: string;
  let accountId: string;
  let accountJid: string;

  beforeEach(async () => {
    await resetDatabase();
    const owner = await register(
      { email: 'owner@example.com', password: 'correcthorsebatterystaple', displayName: 'Owner' },
      device,
    );
    businessId = owner.business.id;
    ownerId = owner.user.id;
    accountJid = '15550001111@s.whatsapp.net';
    accountId = await createTestAccount(businessId, accountJid);
  });

  afterAll(async () => {
    await incomingMessagesWorker.close();
    await realtimeEventsWorker.close();
    await incomingMessagesQueue.close();
    await realtimeEventsQueue.close();
  });

  /**
   * Phase 3B: a genuinely new, live, AI-eligible inbound message no longer
   * triggers the AI handoff synchronously within the incoming_messages job
   * - it schedules a trailing-edge debounce (see scheduleAiDebounce /
   * processAiDebounce) that fires AI_DEBOUNCE_DELAY_MS later on a
   * different queue/worker. This waits for both: the message actually
   * persisted, and the debounce round for this business actually ran to
   * completion, so assertions below see the real, final outcome rather
   * than racing ahead of it.
   */
  async function sendInboundAndWaitForAiHandoff(messageId: string, textPreview: string): Promise<void> {
    const ingested: IngestedWhatsAppMessage = {
      messageId,
      remoteJid: '15550003333@s.whatsapp.net',
      jidKind: 'individual',
      phoneNumber: '+15550003333',
      participant: null,
      fromMe: false,
      pushName: 'AI Reply Test Contact',
      isLive: true,
      upsertType: 'notify',
      messageTimestamp: new Date().toISOString(),
      contentType: 'text',
      documentSubtype: null,
      mimetype: null,
      fileName: null,
      textPreview,
      mediaDescriptor: null,
      ingestedAt: new Date().toISOString(),
    };

    const persisted = new Promise<void>((resolve, reject) => {
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

    // Scoped by businessId (fresh per test via resetDatabase + register),
    // not messageId, since the debounce job's own payload never carries
    // message content - only "check this business's chat now".
    const debounced = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out waiting for AI debounce round to fire')), 20_000);
      realtimeEventsWorker.on('completed', function onCompleted(job) {
        if (job.name !== 'ai-debounce' || job.data.businessId !== businessId) return;
        clearTimeout(timeout);
        realtimeEventsWorker.off('completed', onCompleted);
        resolve();
      });
    });

    await enqueueIncomingMessage({ businessId, whatsappAccountId: accountId, accountJid, message: ingested });
    await persisted;
    await debounced;
  }

  it('never fabricates an outbound send when the business has no active AI agent configured', async () => {
    const messageId = `AI-NOAGENT-${Date.now()}`;
    await sendInboundAndWaitForAiHandoff(messageId, 'Do you have any availability tomorrow?');

    const messageRepository = new WhatsAppMessageRepository(pool);
    const persisted = await messageRepository.findByWhatsAppId(businessId, accountId, messageId);
    expect(persisted).not.toBeNull(); // The inbound message itself is always persisted regardless of AI handoff.

    const { rows } = await pool.query('SELECT count(*) AS count FROM whatsapp_outbound_messages WHERE business_id = $1', [
      businessId,
    ]);
    expect(Number(rows[0].count)).toBe(0);
  }, 25_000);

  it('a "no_agent" outcome is never silent - it hands the chat to a human and notifies the business, not just a server log', async () => {
    // Reproduces the real reported symptom: an operator's only agent is
    // scoped to a trigger keyword that does not match this message, so
    // routing legitimately returns 'no_agent'. Before this fix that
    // returned with nothing but a console.log line the operator would never
    // see, so a real customer could go unanswered indefinitely with no one
    // aware of it.
    const agents = new AiAgentRepository(pool);
    await agents.create({ businessId, name: 'Bookings', triggerKeywords: ['appointment'] });

    const messageId = `AI-NOAGENT-VISIBLE-${Date.now()}`;
    await sendInboundAndWaitForAiHandoff(messageId, 'hey, are you open on weekends?');

    const messageRepository = new WhatsAppMessageRepository(pool);
    const persisted = await messageRepository.findByWhatsAppId(businessId, accountId, messageId);
    expect(persisted).not.toBeNull();

    const chats = new WhatsAppChatRepository(pool);
    const chat = await chats.findById(persisted!.chatId);
    expect(chat?.aiMode).toBe('HUMAN_TAKEOVER');

    const notifications = new NotificationRepository(pool);
    const list = await notifications.listForUser(businessId, ownerId, 10);
    expect(list.some((n) => n.type === 'HUMAN_HANDOFF' && n.targetId === persisted!.chatId)).toBe(true);
  }, 25_000);

  it('never fabricates an outbound send when an agent exists but the AI model is unavailable (no GEMINI_API_KEY) - and makes that visible, not silent', async () => {
    if (process.env.GEMINI_API_KEY) return; // This test asserts the honest-unavailable path specifically.

    const agents = new AiAgentRepository(pool);
    await agents.create({ businessId, name: 'Reception Agent', systemInstruction: 'Help qualify inbound leads.' });

    const messageId = `AI-UNAVAILABLE-${Date.now()}`;
    await sendInboundAndWaitForAiHandoff(messageId, 'What time do you open?');

    const { rows } = await pool.query('SELECT count(*) AS count FROM whatsapp_outbound_messages WHERE business_id = $1', [
      businessId,
    ]);
    expect(Number(rows[0].count)).toBe(0);

    // Reproduces a second real reported symptom: routing succeeds (a real
    // agent was selected), but the model call itself is unavailable and
    // Goose failover isn't configured either. Before this fix that was also
    // silent - only a server log line - so a perfectly-configured agent
    // could still never produce a visible reply, with no clue why.
    const messageRepository = new WhatsAppMessageRepository(pool);
    const persisted = await messageRepository.findByWhatsAppId(businessId, accountId, messageId);
    const chats = new WhatsAppChatRepository(pool);
    const chat = await chats.findById(persisted!.chatId);
    expect(chat?.aiMode).toBe('HUMAN_TAKEOVER');

    const notifications = new NotificationRepository(pool);
    const list = await notifications.listForUser(businessId, ownerId, 10);
    const failure = list.find((n) => n.type === 'AI_FAILURE' && n.targetId === persisted!.chatId);
    expect(failure).toBeDefined();
    expect(failure?.body).toContain('GEMINI_API_KEY is not configured');
  }, 25_000);
});
