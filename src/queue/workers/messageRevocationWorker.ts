import { Worker, type Job } from 'bullmq';
import { queueConnection } from '../connection.js';
import {
  MESSAGE_REVOCATIONS_QUEUE,
  type MessageRevocationJobData,
  type RevocationJobData,
  type StatusRevocationJobData,
} from '../queues/messageRevocationsQueue.js';
import { whatsappConnectionService } from '../../services/whatsappConnectionService.js';
import { publishRealtimeEvent } from '../../realtime/pubsub.js';
import { pool } from '../../db/pool.js';
import { WhatsAppMessageRepository } from '../../repositories/whatsappMessageRepository.js';
import { WhatsAppChatRepository } from '../../repositories/whatsappChatRepository.js';
import { WhatsAppContactRepository } from '../../repositories/whatsappContactRepository.js';
import { ScheduledStatusRepository } from '../../repositories/scheduledStatusRepository.js';

/**
 * Runs in the API server process for the same reason outboundDispatchWorker
 * does: the live Baileys socket only exists in whichever process actually
 * called connect(). A worker elsewhere could never really revoke anything.
 */
const messageRepository = new WhatsAppMessageRepository(pool);
const chatRepository = new WhatsAppChatRepository(pool);
const contactRepository = new WhatsAppContactRepository(pool);
const scheduledStatusRepository = new ScheduledStatusRepository(pool);

function isFinalAttempt(job: Job): boolean {
  return job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
}

/**
 * Issues WhatsApp's real "delete for everyone" for one of our own messages.
 *
 * What this genuinely proves on success: WhatsApp accepted the revoke
 * instruction. What it does NOT prove: that every recipient device removed
 * it. WhatsApp only honours delete-for-everyone inside its own time window,
 * and a recipient offline or on an old client may keep it. That is why the
 * success state is recorded as 'revoke_sent' rather than 'deleted'.
 */
async function revokeMessage(job: Job<RevocationJobData>, data: MessageRevocationJobData): Promise<void> {
  const { messageId, businessId } = data;

  const message = await messageRepository.findById(messageId);
  if (!message) {
    console.warn(`[MessageRevocationWorker] No such message ${messageId}`);
    return;
  }
  if (message.revokeStatus === 'revoke_sent') return; // already done; a retry must not double-send

  const chat = await chatRepository.findById(message.chatId);
  if (!chat) {
    await messageRepository.markRevokeFailed(messageId, 'Chat no longer exists');
    return;
  }

  const socket = whatsappConnectionService.getSocket();
  if (!socket) throw new Error('WhatsApp socket unavailable'); // retried by BullMQ

  try {
    await socket.sendMessage(chat.chatJid, {
      delete: {
        remoteJid: chat.chatJid,
        fromMe: message.fromMe,
        id: message.whatsappMessageId,
        // Groups need the original sender to identify the message; a 1:1
        // chat must not carry it.
        ...(chat.isGroup ? { participant: message.senderJid } : {}),
      },
    });

    await messageRepository.markRevokeSent(messageId);
    await publishRealtimeEvent({ type: 'message.new', businessId, chatId: message.chatId });
    console.log(`[MessageRevocationWorker] Revoke instruction sent for message ${messageId}`);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    // Final attempt: record the honest failure rather than leaving it stuck
    // in 'requested' forever.
    if (isFinalAttempt(job)) {
      await messageRepository.markRevokeFailed(messageId, reason);
      await publishRealtimeEvent({ type: 'message.new', businessId, chatId: message.chatId });
    }
    throw error;
  }
}

/**
 * Recalls a published Status post. Same REVOKE protocol message, addressed
 * to status@broadcast, and fanned out to the same real audience the post
 * went to - the account's own saved individual contacts.
 */
async function revokeStatus(job: Job<RevocationJobData>, data: StatusRevocationJobData): Promise<void> {
  const { scheduledStatusId } = data;

  const record = await scheduledStatusRepository.findById(scheduledStatusId);
  if (!record) {
    console.warn(`[MessageRevocationWorker] No such scheduled status ${scheduledStatusId}`);
    return;
  }
  if (record.revokeStatus === 'revoke_sent') return;
  if (!record.publishedWhatsappMessageId) {
    await scheduledStatusRepository.markRevokeFailed(
      scheduledStatusId,
      'No stored WhatsApp key for this post - it cannot be recalled.',
    );
    return;
  }

  const socket = whatsappConnectionService.getSocket();
  if (!socket) throw new Error('WhatsApp socket unavailable');

  try {
    const statusJidList = await contactRepository.listIndividualJidsForAccount(record.businessId, record.whatsappAccountId);
    await socket.sendMessage(
      'status@broadcast',
      { delete: { remoteJid: 'status@broadcast', fromMe: true, id: record.publishedWhatsappMessageId } },
      { statusJidList, broadcast: true },
    );

    await scheduledStatusRepository.markRevokeSent(scheduledStatusId);
    console.log(`[MessageRevocationWorker] Recall instruction sent for status ${scheduledStatusId}`);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (isFinalAttempt(job)) await scheduledStatusRepository.markRevokeFailed(scheduledStatusId, reason);
    throw error;
  }
}

async function processJob(job: Job<RevocationJobData>): Promise<void> {
  if (job.data.kind === 'status') return revokeStatus(job, job.data);
  return revokeMessage(job, job.data);
}

export const messageRevocationWorker = new Worker<RevocationJobData>(MESSAGE_REVOCATIONS_QUEUE, processJob, {
  connection: queueConnection,
  concurrency: 2,
});

messageRevocationWorker.on('failed', (job, error) => {
  console.error(`[MessageRevocationWorker] Job ${job?.id} failed:`, error.message);
});

messageRevocationWorker.on('error', (error) => {
  console.error('[MessageRevocationWorker] Worker error:', error.message);
});

console.log(`[MessageRevocationWorker] Listening on queue "${MESSAGE_REVOCATIONS_QUEUE}" (concurrency=2)`);
