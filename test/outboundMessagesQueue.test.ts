import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pool } from '../src/db/pool.js';
import { WhatsAppChatRepository } from '../src/repositories/whatsappChatRepository.js';
import { WhatsAppOutboundMessageRepository } from '../src/repositories/whatsappOutboundMessageRepository.js';
import { createTestAccount, createTestBusiness, resetDatabase } from './helpers.js';

// A fake, in-test WhatsApp socket - real Baileys can't run against a live
// account in CI, so this is what stands in for "the send actually reached
// WhatsApp." isReady/getSocket are the exact two methods the outbound
// worker calls; sendMessage is the exact call whose success/failure this
// suite controls per test.
const isReadyMock = vi.fn<() => boolean>();
const sendMessageMock = vi.fn<(jid: string, content: unknown) => Promise<{ key: { id: string } }>>();
const getSocketMock = vi.fn(() => ({ sendMessage: sendMessageMock }));

vi.mock('../src/services/whatsappConnectionManager.js', () => ({
  whatsappConnectionManager: {
    isReady: (_businessId: string) => isReadyMock(),
    getSocket: (_businessId: string) => getSocketMock(),
  },
}));

const { enqueueOutboundMessage, outboundMessagesQueue } = await import('../src/queue/queues/outboundMessagesQueue.js');
const { outboundMessagesWorker } = await import('../src/queue/workers/outboundDispatchWorker.js');
const { sweepStaleOutboundMessages } = await import('../src/queue/workers/incomingMessagesWorker.js');

/**
 * BullMQ's Worker emits 'failed' after every attempt, not only the last one
 * - a job with retries left is expected to fail-then-retry, so that event
 * alone can't tell "genuinely done" from "about to retry." The outbound
 * row's own status is the real, authoritative outcome (exactly the thing
 * under test): poll until it reaches a terminal state.
 */
async function waitForOutcome(
  repository: WhatsAppOutboundMessageRepository,
  outboundMessageId: string,
): Promise<'sent' | 'failed'> {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    const record = await repository.findById(outboundMessageId);
    if (record?.status === 'sent' || record?.status === 'failed') return record.status;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for outbound message to reach a terminal status');
}

describe('outbound_messages BullMQ pipeline (real Redis queue + real worker + real Postgres, fake WhatsApp socket)', () => {
  let businessId: string;
  let accountId: string;
  let chatId: string;
  const toJid = '15550008888@s.whatsapp.net';

  beforeEach(async () => {
    await resetDatabase();
    businessId = await createTestBusiness();
    accountId = await createTestAccount(businessId);
    const chatRepository = new WhatsAppChatRepository(pool);
    const chat = await chatRepository.upsertFromWhatsApp({
      businessId,
      whatsappAccountId: accountId,
      chatJid: toJid,
      jidKind: 'individual',
      chatType: 'individual',
    });
    chatId = chat.id;
    isReadyMock.mockReset();
    sendMessageMock.mockReset();
    getSocketMock.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await outboundMessagesWorker.close();
    await outboundMessagesQueue.close();
  });

  it('dispatches a real send through the fake socket and records the real WhatsApp message id', async () => {
    isReadyMock.mockReturnValue(true);
    sendMessageMock.mockResolvedValue({ key: { id: 'WA-SENT-abc123' } });

    const repository = new WhatsAppOutboundMessageRepository(pool);
    const record = await repository.createIdempotent({
      businessId,
      whatsappAccountId: accountId,
      chatId,
      toJid,
      idempotencyKey: 'dispatch-success',
      messageType: 'text',
      textContent: 'A message dispatched through the real queue+worker',
    });

    await enqueueOutboundMessage({ outboundMessageId: record.id });
    const outcome = await waitForOutcome(repository, record.id);

    expect(outcome).toBe('sent');
    expect(sendMessageMock).toHaveBeenCalledWith(toJid, { text: 'A message dispatched through the real queue+worker' });

    const updated = await repository.findById(record.id);
    expect(updated?.status).toBe('sent');
    expect(updated?.whatsappMessageId).toBe('WA-SENT-abc123');
  });

  it('retries a transient failure and only marks the row failed once every real attempt is exhausted', async () => {
    isReadyMock.mockReturnValue(true);
    sendMessageMock.mockRejectedValue(new Error('Simulated transient WhatsApp send failure'));

    const repository = new WhatsAppOutboundMessageRepository(pool);
    const record = await repository.createIdempotent({
      businessId,
      whatsappAccountId: accountId,
      chatId,
      toJid,
      idempotencyKey: 'dispatch-retry-exhausted',
      messageType: 'text',
      textContent: 'This will keep failing',
    });

    // Override the queue's default 5-attempt/exponential-backoff policy with
    // a fast one for this test only - the retry MECHANISM under test is the
    // same BullMQ attempts/backoff wiring, just sped up so the suite doesn't
    // take a real minute-plus to exhaust 5 exponential-backoff attempts.
    await outboundMessagesQueue.add(
      'send',
      { outboundMessageId: record.id },
      { attempts: 3, backoff: { type: 'fixed', delay: 50 } },
    );
    const outcome = await waitForOutcome(repository, record.id);

    expect(outcome).toBe('failed');
    expect(sendMessageMock).toHaveBeenCalledTimes(3);

    const updated = await repository.findById(record.id);
    expect(updated?.status).toBe('failed');
    expect(updated?.lastError).toContain('Simulated transient WhatsApp send failure');
    expect(updated?.sentAt).toBeNull();
  });

  it('never calls sendMessage when WhatsApp is not connected, and fails the job so it can retry once reconnected', async () => {
    isReadyMock.mockReturnValue(false);

    const repository = new WhatsAppOutboundMessageRepository(pool);
    const record = await repository.createIdempotent({
      businessId,
      whatsappAccountId: accountId,
      chatId,
      toJid,
      idempotencyKey: 'dispatch-not-ready',
      messageType: 'text',
      textContent: 'Cannot send while disconnected',
    });

    await outboundMessagesQueue.add(
      'send',
      { outboundMessageId: record.id },
      { attempts: 1, backoff: { type: 'fixed', delay: 50 } },
    );
    const outcome = await waitForOutcome(repository, record.id);

    expect(outcome).toBe('failed');
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('never re-sends after a crash between the real send call and recording it - marks indeterminate instead', async () => {
    isReadyMock.mockReturnValue(true);
    sendMessageMock.mockResolvedValue({ key: { id: 'WA-SHOULD-NOT-BE-CALLED' } });

    const repository = new WhatsAppOutboundMessageRepository(pool);
    const record = await repository.createIdempotent({
      businessId,
      whatsappAccountId: accountId,
      chatId,
      toJid,
      idempotencyKey: 'dispatch-crash-mid-flight',
      messageType: 'text',
      textContent: 'Simulates a worker that died right after calling WhatsApp',
    });

    // Simulates the exact crash window under test: a previous attempt got
    // as far as committing markSendAttempted() (the marker set immediately
    // before the real sendMessage call) but never reached markSent() - the
    // worker process died in between, before it ever ran here.
    await repository.markSending(record.id);
    await repository.markSendAttempted(record.id);

    await enqueueOutboundMessage({ outboundMessageId: record.id });

    const deadline = Date.now() + 12_000;
    let updated = await repository.findById(record.id);
    while (Date.now() < deadline && updated?.status !== 'indeterminate') {
      await new Promise((resolve) => setTimeout(resolve, 50));
      updated = await repository.findById(record.id);
    }

    expect(updated?.status).toBe('indeterminate');
    expect(updated?.lastError).toContain('reached the point of calling WhatsApp');
    // The real proof this fix matters: sendMessage must never be called on
    // this resumed attempt, however many times BullMQ would otherwise retry.
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('still sends normally when only markSending ran before - proves the new marker does not block a real first attempt', async () => {
    isReadyMock.mockReturnValue(true);
    sendMessageMock.mockResolvedValue({ key: { id: 'WA-SENT-normal-path' } });

    const repository = new WhatsAppOutboundMessageRepository(pool);
    const record = await repository.createIdempotent({
      businessId,
      whatsappAccountId: accountId,
      chatId,
      toJid,
      idempotencyKey: 'dispatch-marker-happy-path',
      messageType: 'text',
      textContent: 'A completely normal send, never interrupted',
    });

    await enqueueOutboundMessage({ outboundMessageId: record.id });
    const outcome = await waitForOutcome(repository, record.id);

    expect(outcome).toBe('sent');
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    const updated = await repository.findById(record.id);
    expect(updated?.sendAttemptedAt).not.toBeNull();
  });

  it('sweeps a send abandoned mid-dispatch (stuck sending, no worker left to resolve it) to failed', async () => {
    const repository = new WhatsAppOutboundMessageRepository(pool);
    const record = await repository.createIdempotent({
      businessId,
      whatsappAccountId: accountId,
      chatId,
      toJid,
      idempotencyKey: 'sweep-stale',
      messageType: 'text',
      textContent: 'Abandoned before a result was ever recorded',
    });
    await repository.markSending(record.id);
    await pool.query(`UPDATE whatsapp_outbound_messages SET updated_at = now() - interval '10 minutes' WHERE id = $1`, [
      record.id,
    ]);

    await sweepStaleOutboundMessages();

    const updated = await repository.findById(record.id);
    expect(updated?.status).toBe('failed');
    expect(updated?.lastError).toContain('Abandoned mid-send');
  });
});
