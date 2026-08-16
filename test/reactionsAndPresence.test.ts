import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { WhatsAppChatRepository } from '../src/repositories/whatsappChatRepository.js';
import { WhatsAppMessageRepository } from '../src/repositories/whatsappMessageRepository.js';
import { WhatsAppMessageReactionRepository } from '../src/repositories/whatsappMessageReactionRepository.js';
import { WhatsAppPresenceRepository } from '../src/repositories/whatsappPresenceRepository.js';
import {
  enqueueMessageReaction,
  enqueuePresenceUpdate,
  realtimeEventsQueue,
  type MessageReactionJobData,
} from '../src/queue/queues/realtimeEventsQueue.js';
import { realtimeEventsWorker, incomingMessagesWorker } from '../src/queue/workers/incomingMessagesWorker.js';
import { incomingMessagesQueue } from '../src/queue/queues/incomingMessagesQueue.js';
import { subscribeToRealtimeEvents, type RealtimeEvent } from '../src/realtime/pubsub.js';
import { createTestAccount, createTestBusiness, resetDatabase } from './helpers.js';

/** Waits for the real worker to finish a specific real-time job, matched by a predicate over its data. */
function waitForJob(jobName: string, matches: (data: unknown) => boolean, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 10_000);
    realtimeEventsWorker.on('completed', function onCompleted(job) {
      if (job.name !== jobName || !matches(job.data)) return;
      clearTimeout(timeout);
      realtimeEventsWorker.off('completed', onCompleted);
      resolve();
    });
  });
}

describe('real message reactions + presence (real Redis + real worker + real Postgres)', () => {
  let businessId: string;
  let accountId: string;
  const accountJid = '15550009999@s.whatsapp.net';

  beforeEach(async () => {
    await resetDatabase();
    businessId = await createTestBusiness();
    accountId = await createTestAccount(businessId, accountJid);
  });

  afterAll(async () => {
    await realtimeEventsWorker.close();
    await incomingMessagesWorker.close();
    await realtimeEventsQueue.close();
    await incomingMessagesQueue.close();
  });

  async function insertTestMessage(whatsappMessageId: string) {
    const chatRepository = new WhatsAppChatRepository(pool);
    const messageRepository = new WhatsAppMessageRepository(pool);
    const chat = await chatRepository.upsertFromWhatsApp({
      businessId,
      whatsappAccountId: accountId,
      chatJid: '15550001111@s.whatsapp.net',
      jidKind: 'individual',
      chatType: 'individual',
    });
    const message = await messageRepository.insert({
      businessId,
      whatsappAccountId: accountId,
      chatId: chat.id,
      whatsappMessageId,
      remoteJid: chat.chatJid,
      senderJid: chat.chatJid,
      direction: 'inbound',
      messageType: 'text',
      textContent: 'a real message to react to',
      timestamp: new Date().toISOString(),
      fromMe: false,
      isHistorical: false,
    });
    return { chat, message };
  }

  function reactionJob(overrides: Partial<MessageReactionJobData> = {}): MessageReactionJobData {
    return {
      businessId,
      whatsappAccountId: accountId,
      accountJid,
      targetWhatsappMessageId: 'REACT-TARGET-1',
      reaction: {
        key: { remoteJid: '15550001111@s.whatsapp.net', fromMe: false, participant: '15550002222@s.whatsapp.net', id: 'RK-1' },
        text: '👍',
      },
      ...overrides,
    };
  }

  it('inserts a real reaction row into whatsapp_message_reactions, never into whatsapp_messages', async () => {
    const { message } = await insertTestMessage('REACT-TARGET-1');
    const reactionRepository = new WhatsAppMessageReactionRepository(pool);

    const done = waitForJob('message-reaction', (d) => (d as MessageReactionJobData).targetWhatsappMessageId === 'REACT-TARGET-1', 'insert');
    await enqueueMessageReaction(reactionJob());
    await done;

    const reactions = await reactionRepository.listByMessage(message.id);
    expect(reactions).toHaveLength(1);
    expect(reactions[0]?.reactorJid).toBe('15550002222@s.whatsapp.net');
    expect(reactions[0]?.reaction).toBe('👍');

    const { rows } = await pool.query('SELECT count(*)::int AS n FROM whatsapp_messages WHERE whatsapp_message_id = $1', [
      'RK-1',
    ]);
    expect(rows[0].n).toBe(0); // the reaction event itself never becomes a standalone message
  });

  it('updates the same reactor\'s reaction in place rather than accumulating rows', async () => {
    const { message } = await insertTestMessage('REACT-TARGET-2');
    const reactionRepository = new WhatsAppMessageReactionRepository(pool);

    const first = waitForJob('message-reaction', (d) => (d as MessageReactionJobData).reaction.text === '👍', 'first reaction');
    await enqueueMessageReaction(reactionJob({ targetWhatsappMessageId: 'REACT-TARGET-2' }));
    await first;

    const second = waitForJob('message-reaction', (d) => (d as MessageReactionJobData).reaction.text === '❤️', 'changed reaction');
    await enqueueMessageReaction(
      reactionJob({
        targetWhatsappMessageId: 'REACT-TARGET-2',
        reaction: { key: { remoteJid: '15550001111@s.whatsapp.net', fromMe: false, participant: '15550002222@s.whatsapp.net', id: 'RK-2' }, text: '❤️' },
      }),
    );
    await second;

    const reactions = await reactionRepository.listByMessage(message.id);
    expect(reactions).toHaveLength(1);
    expect(reactions[0]?.reaction).toBe('❤️');
  });

  it('removes the reaction row when WhatsApp reports removal (empty text), never leaving a blank reaction', async () => {
    const { message } = await insertTestMessage('REACT-TARGET-3');
    const reactionRepository = new WhatsAppMessageReactionRepository(pool);

    const added = waitForJob('message-reaction', (d) => Boolean((d as MessageReactionJobData).reaction.text), 'add');
    await enqueueMessageReaction(reactionJob({ targetWhatsappMessageId: 'REACT-TARGET-3' }));
    await added;
    expect(await reactionRepository.listByMessage(message.id)).toHaveLength(1);

    const removed = waitForJob('message-reaction', (d) => !(d as MessageReactionJobData).reaction.text, 'removal');
    await enqueueMessageReaction(
      reactionJob({
        targetWhatsappMessageId: 'REACT-TARGET-3',
        reaction: { key: { remoteJid: '15550001111@s.whatsapp.net', fromMe: false, participant: '15550002222@s.whatsapp.net', id: 'RK-3' }, text: '' },
      }),
    );
    await removed;

    expect(await reactionRepository.listByMessage(message.id)).toHaveLength(0);
  });

  it('is idempotent for a genuinely duplicated reaction event (same reactor, same emoji, twice)', async () => {
    const { message } = await insertTestMessage('REACT-TARGET-4');
    const reactionRepository = new WhatsAppMessageReactionRepository(pool);

    for (let i = 0; i < 2; i += 1) {
      const done = waitForJob('message-reaction', (d) => (d as MessageReactionJobData).targetWhatsappMessageId === 'REACT-TARGET-4', `duplicate ${i}`);
      await enqueueMessageReaction(reactionJob({ targetWhatsappMessageId: 'REACT-TARGET-4' }));
      await done;
    }

    expect(await reactionRepository.listByMessage(message.id)).toHaveLength(1);
  });

  it('never creates a reaction for the wrong tenant (business mismatch)', async () => {
    const { message } = await insertTestMessage('REACT-TARGET-5');
    const otherBusinessId = await createTestBusiness();
    const otherAccountId = await createTestAccount(otherBusinessId, '15559999999@s.whatsapp.net');
    const reactionRepository = new WhatsAppMessageReactionRepository(pool);

    const done = waitForJob('message-reaction', (d) => (d as MessageReactionJobData).targetWhatsappMessageId === 'REACT-TARGET-5', 'cross-tenant');
    await enqueueMessageReaction(
      reactionJob({ targetWhatsappMessageId: 'REACT-TARGET-5', businessId: otherBusinessId, whatsappAccountId: otherAccountId }),
    );
    await done;

    expect(await reactionRepository.listByMessage(message.id)).toHaveLength(0);
  });

  it('never creates a reaction for the wrong WhatsApp account within the same business', async () => {
    const { message } = await insertTestMessage('REACT-TARGET-6');
    const otherAccountId = await createTestAccount(businessId, '15558888888@s.whatsapp.net');
    const reactionRepository = new WhatsAppMessageReactionRepository(pool);

    const done = waitForJob('message-reaction', (d) => (d as MessageReactionJobData).targetWhatsappMessageId === 'REACT-TARGET-6', 'cross-account');
    await enqueueMessageReaction(reactionJob({ targetWhatsappMessageId: 'REACT-TARGET-6', whatsappAccountId: otherAccountId }));
    await done;

    expect(await reactionRepository.listByMessage(message.id)).toHaveLength(0);
  });

  it('never creates a reaction for a message that was never persisted (not yet arrived, or Sentinel-blocked)', async () => {
    const reactionRepository = new WhatsAppMessageReactionRepository(pool);
    const done = waitForJob('message-reaction', (d) => (d as MessageReactionJobData).targetWhatsappMessageId === 'REACT-TARGET-NEVER-EXISTED', 'missing target');
    await enqueueMessageReaction(reactionJob({ targetWhatsappMessageId: 'REACT-TARGET-NEVER-EXISTED' }));
    await done; // completes without throwing - honest no-op, not a crash

    const { rows } = await pool.query('SELECT count(*)::int AS n FROM whatsapp_message_reactions');
    expect(rows[0].n).toBe(0);
  });

  it('publishes a real message.reaction event only after the reaction row is committed', async () => {
    const { message, chat } = await insertTestMessage('REACT-TARGET-7');
    const events: RealtimeEvent[] = [];
    const unsubscribe = subscribeToRealtimeEvents((event) => events.push(event));
    await new Promise((resolve) => setTimeout(resolve, 200));

    const done = waitForJob('message-reaction', (d) => (d as MessageReactionJobData).targetWhatsappMessageId === 'REACT-TARGET-7', 'realtime');
    await enqueueMessageReaction(reactionJob({ targetWhatsappMessageId: 'REACT-TARGET-7' }));
    await done;
    await new Promise((resolve) => setTimeout(resolve, 200));
    unsubscribe();

    expect(events).toContainEqual({ type: 'message.reaction', businessId, chatId: chat.id, messageId: message.id });
  });

  it('records a real presence event with the real reported state and last-seen', async () => {
    const presenceRepository = new WhatsAppPresenceRepository(pool);
    const contactJid = '15550003333@s.whatsapp.net';
    const lastSeenUnix = Math.floor(Date.now() / 1000) - 60;

    const done = waitForJob('presence-update', (d) => (d as { contactJid: string }).contactJid === contactJid, 'presence');
    await enqueuePresenceUpdate({
      businessId,
      whatsappAccountId: accountId,
      contactJid,
      presence: { lastKnownPresence: 'composing', lastSeen: lastSeenUnix },
    });
    await done;

    const latest = await presenceRepository.findLatest(businessId, accountId, contactJid);
    expect(latest?.presenceState).toBe('composing');
    expect(latest?.lastSeenAt).not.toBeNull();
    expect(Math.round(new Date(latest!.lastSeenAt!).getTime() / 1000)).toBe(lastSeenUnix);
  });

  it('never fabricates a last-seen timestamp when the connector does not provide one', async () => {
    const presenceRepository = new WhatsAppPresenceRepository(pool);
    const contactJid = '15550004444@s.whatsapp.net';

    const done = waitForJob('presence-update', (d) => (d as { contactJid: string }).contactJid === contactJid, 'no last-seen');
    await enqueuePresenceUpdate({
      businessId,
      whatsappAccountId: accountId,
      contactJid,
      presence: { lastKnownPresence: 'available' },
    });
    await done;

    const latest = await presenceRepository.findLatest(businessId, accountId, contactJid);
    expect(latest?.lastSeenAt).toBeNull();
  });

  it('preserves a @lid contact JID exactly for presence, never rewriting it', async () => {
    const presenceRepository = new WhatsAppPresenceRepository(pool);
    const lidJid = '234471341175024@lid';

    const done = waitForJob('presence-update', (d) => (d as { contactJid: string }).contactJid === lidJid, '@lid presence');
    await enqueuePresenceUpdate({
      businessId,
      whatsappAccountId: accountId,
      contactJid: lidJid,
      presence: { lastKnownPresence: 'unavailable' },
    });
    await done;

    const latest = await presenceRepository.findLatest(businessId, accountId, lidJid);
    expect(latest?.contactJid).toBe(lidJid);
  });

  it('isolates presence records between tenants for the same contact JID string', async () => {
    const presenceRepository = new WhatsAppPresenceRepository(pool);
    const contactJid = '15550005555@s.whatsapp.net';
    const otherBusinessId = await createTestBusiness();
    const otherAccountId = await createTestAccount(otherBusinessId, '15557777777@s.whatsapp.net');

    const doneA = waitForJob(
      'presence-update',
      (d) => (d as { contactJid: string; businessId: string }).businessId === businessId,
      'tenant A presence',
    );
    await enqueuePresenceUpdate({ businessId, whatsappAccountId: accountId, contactJid, presence: { lastKnownPresence: 'available' } });
    await doneA;

    const otherLatest = await presenceRepository.findLatest(otherBusinessId, otherAccountId, contactJid);
    expect(otherLatest).toBeNull(); // tenant B never sees tenant A's presence row for the same JID string
  });
});
