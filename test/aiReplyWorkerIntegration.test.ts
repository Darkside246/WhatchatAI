import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
import { AiUsageRepository } from '../src/repositories/aiUsageRepository.js';
import { createTestAccount, createTestSubscription, resetDatabase } from './helpers.js';
import { waitForWorkerEvent } from './waitForWorkerEvent.js';

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

  /**
   * AURA engineering directive, "Remove race conditions" (2026-09-04):
   * `new Worker(...)`/`new Queue(...)` return immediately, but their real
   * Redis connection and (for a Worker) job-fetching loop start
   * asynchronously in the background - importing this file's modules
   * does not itself guarantee either is actually ready to move a job yet.
   * A test that enqueues its very first job immediately after import (the
   * common case: this file's very first `it()`) had an implicit,
   * undeclared assumption that connection setup always finishes well
   * within its promise's timeout - true on a lightly loaded machine, not
   * guaranteed under real contention. `waitUntilReady()` is BullMQ's own
   * real primitive for this exact problem; awaiting it once, for every
   * queue/worker this file drives, before any test enqueues a job
   * replaces that implicit assumption with a genuine, observable
   * precondition.
   */
  beforeAll(async () => {
    await Promise.all([
      incomingMessagesWorker.waitUntilReady(),
      realtimeEventsWorker.waitUntilReady(),
      incomingMessagesQueue.waitUntilReady(),
      realtimeEventsQueue.waitUntilReady(),
    ]);
  });

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
   *
   * The two waits are deliberately sequenced, not both started upfront:
   * the debounce round is a real causal consequence of the message having
   * persisted, so a caller has no reason to be waiting for it before that
   * happened - constructing both eagerly (the previous shape) meant a
   * `persisted` timeout left `debounced`'s own already-ticking timer
   * orphaned with nothing left awaiting it, a genuine unhandled promise
   * rejection that crashed the whole worker process via its own global
   * handler. Sequencing removes the race at its root instead of papering
   * over the symptom with a no-op `.catch()`.
   */
  async function sendInboundAndWaitForAiHandoff(messageId: string, textPreview: string, remoteJid = '15550003333@s.whatsapp.net'): Promise<void> {
    const ingested: IngestedWhatsAppMessage = {
      messageId,
      remoteJid,
      jidKind: 'individual',
      phoneNumber: `+${remoteJid.split('@')[0]}`,
      participant: null,
      remoteJidAlt: null,
      participantAlt: null,
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
      // The real, untruncated text - what actually gets persisted as
      // textContent (see whatsappMessagePersistenceService.ts). Without
      // this, needsAiHandoff in incomingMessagesWorker.ts is silently
      // false and scheduleAiDebounce never fires - the real cause of the
      // "Timed out waiting for AI debounce round" failures below (a stale
      // fixture predating fullText's introduction, not a timing issue).
      fullText: textPreview,
      mediaDescriptor: null,
      ingestedAt: new Date().toISOString(),
    };

    // Listeners are registered (inside waitForWorkerEvent, called next)
    // before the job is created below - never the other way around, which
    // would risk missing a fast completion entirely.
    const persisted = waitForWorkerEvent(
      incomingMessagesWorker,
      (job) => (job.data as { message: { messageId: string } }).message.messageId === messageId,
      10_000,
      'Timed out waiting for worker to process job',
      (job) => (job?.data as { message: { messageId: string } } | undefined)?.message.messageId === messageId,
    );

    await enqueueIncomingMessage({ businessId, whatsappAccountId: accountId, accountJid, message: ingested });
    await persisted;

    // Only started once the raw message has actually persisted - a real
    // causal sequence, not two independent races. A chat already in
    // HUMAN_TAKEOVER from an earlier message in the same test never gets a
    // new debounce round scheduled at all (needsAiHandoff in
    // incomingMessagesWorker.ts requires ai_mode AI_ACTIVE) - callers that
    // hit that case should use a different contact/chat per message, not
    // rely on this wait timing out gracefully.
    //
    // Scoped by businessId (fresh per test via resetDatabase + register),
    // not messageId, since the debounce job's own payload never carries
    // message content - only "check this business's chat now".
    await waitForWorkerEvent(
      realtimeEventsWorker,
      (job) => (job as { name: string; data: { businessId: string } }).name === 'ai-debounce' && (job as { data: { businessId: string } }).data.businessId === businessId,
      20_000,
      'Timed out waiting for AI debounce round to fire',
    );
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

  /**
   * Section 34-40's real budget-override flow: a business that has
   * exhausted its plan's monthly AI budget gets a second, distinct
   * notification naming a real upsell - not just the generic AI_FAILURE
   * hand-off every other 'unavailable' cause already produces.
   */
  it('a budget-exhausted business gets a distinct AI_BUDGET_EXCEEDED notification naming the real top-up offer, exactly once per month', async () => {
    await createTestSubscription(businessId, 'starter');
    const usage = new AiUsageRepository(pool);
    await usage.record({ businessId, model: 'gemini-test', callKind: 'primary', promptTokens: 300_000, candidatesTokens: 300_000, totalTokens: 600_000 });

    const agents = new AiAgentRepository(pool);
    await agents.create({ businessId, name: 'Reception Agent', systemInstruction: 'Help qualify inbound leads.' });

    const firstMessageId = `AI-BUDGET-1-${Date.now()}`;
    await sendInboundAndWaitForAiHandoff(firstMessageId, 'What time do you open?');

    const notifications = new NotificationRepository(pool);
    const afterFirst = await notifications.listForUser(businessId, ownerId, 20);
    const budgetNotifications = afterFirst.filter((n) => n.type === 'AI_BUDGET_EXCEEDED');
    expect(budgetNotifications).toHaveLength(1);
    expect(budgetNotifications[0]?.body).toContain('250,000');
    expect(budgetNotifications[0]?.body).toContain('$1.99');
    // The existing generic hand-off notification is unaffected - both fire.
    expect(afterFirst.some((n) => n.type === 'AI_FAILURE')).toBe(true);

    // A different contact/chat, deliberately: the first message's own
    // processing already set its chat to ai_mode HUMAN_TAKEOVER (real,
    // correct behavior - needsAiHandoff in incomingMessagesWorker.ts
    // requires AI_ACTIVE), so a second message to that same chat would
    // never schedule a new debounce round at all. The dedup this test
    // proves is scoped to the whole business, not one chat, so a second
    // contact hitting the same exhausted budget is the real scenario.
    const secondMessageId = `AI-BUDGET-2-${Date.now()}`;
    await sendInboundAndWaitForAiHandoff(secondMessageId, 'Are you open on Sundays?', '15550004444@s.whatsapp.net');

    const afterSecond = await notifications.listForUser(businessId, ownerId, 20);
    // A second blocked message this same month must not re-notify the upsell.
    expect(afterSecond.filter((n) => n.type === 'AI_BUDGET_EXCEEDED')).toHaveLength(1);
  }, 30_000);
});
