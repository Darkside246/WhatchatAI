import { pool } from '../db/pool.js';
import { WhatsAppMessageRepository } from '../repositories/whatsappMessageRepository.js';
import { WhatsAppMediaRepository } from '../repositories/whatsappMediaRepository.js';
import { WhatsAppChatRepository } from '../repositories/whatsappChatRepository.js';
import { whatsappOutboundMessageService } from './whatsappOutboundMessageService.js';

const messageRepository = new WhatsAppMessageRepository(pool);
const mediaRepository = new WhatsAppMediaRepository(pool);
const chatRepository = new WhatsAppChatRepository(pool);

/**
 * Sending a message the business already has on to somebody else.
 *
 * A forward is a real, new send, not a pointer: WhatsApp has no "show this
 * person that message" operation, so what reaches the recipient is a fresh
 * message carrying the same content. That is worth being precise about,
 * because it decides two things people assume otherwise - the recipient
 * cannot see the original conversation, and deleting the forward does not
 * touch the original.
 *
 * Media is forwarded by its stored reference rather than re-downloaded and
 * re-uploaded. The bytes are already on disk from the original ingestion;
 * re-fetching them for every recipient would be slower, would hit WhatsApp
 * again for something we have, and could fail for an old message whose
 * media has expired upstream while our copy is fine.
 */

export class ForwardNotPossibleError extends Error {}

export interface ForwardOutcome {
  chatId: string;
  /** The queued outbound row, when it was queued. */
  outboundMessageId: string | null;
  /** Why this one did not go, in words an operator can act on. */
  skippedReason: string | null;
}

/**
 * Message types that can honestly be forwarded.
 *
 * A location, a poll and a shared contact are all structured payloads whose
 * meaning depends on where they were sent - a poll forwarded into another
 * chat would be a new poll nobody voted in, and its results would not be
 * the results anybody is looking at. Rather than send something that looks
 * like the original and behaves differently, these are refused with a
 * reason.
 */
function forwardable(messageType: string): boolean {
  return ['text', 'image', 'video', 'audio', 'document', 'sticker'].includes(messageType);
}

export async function forwardMessage(input: {
  businessId: string;
  whatsappAccountId: string;
  messageId: string;
  /** Where it is going. Every one is checked against this business before anything is sent. */
  chatIds: string[];
  requestedByUserId: string;
}): Promise<ForwardOutcome[]> {
  const source = await messageRepository.findByIdForBusiness(input.messageId, input.businessId);
  if (!source) throw new ForwardNotPossibleError('That message is not in this workspace.');

  if (!forwardable(source.messageType)) {
    throw new ForwardNotPossibleError(
      `A ${source.messageType} cannot be forwarded — it only means something in the conversation it was sent in.`,
    );
  }

  const text = source.textContent ?? '';
  const caption = source.caption ?? '';

  let mediaStorageReference: string | null = null;
  let mediaMimeType: string | null = null;
  let mediaFileName: string | null = null;
  if (source.messageType !== 'text') {
    const media = source.mediaId ? await mediaRepository.findById(source.mediaId) : null;
    /**
     * No local copy means no forward, and it is said rather than guessed
     * at. A media message whose download failed or is still in flight has
     * nothing to send, and quietly forwarding its caption alone would look
     * to the recipient like the whole message.
     */
    if (!media?.storageReference) {
      throw new ForwardNotPossibleError('That attachment has not finished downloading here yet — try again in a moment.');
    }
    mediaStorageReference = media.storageReference;
    mediaMimeType = media.mimeType;
    mediaFileName = media.fileName;
  } else if (!text.trim()) {
    throw new ForwardNotPossibleError('There is nothing in that message to forward.');
  }

  const outcomes: ForwardOutcome[] = [];
  for (const chatId of input.chatIds) {
    // Checked one at a time against this business. A chat id from another
    // tenant, or one that has been deleted, is a skipped row with a reason
    // rather than a failed batch - somebody forwarding to six people should
    // not lose all six because one is stale.
    const chat = await chatRepository.findByIdForBusiness(chatId, input.businessId);
    if (!chat || chat.whatsappAccountId !== input.whatsappAccountId) {
      outcomes.push({ chatId, outboundMessageId: null, skippedReason: 'That conversation is not in this workspace.' });
      continue;
    }
    if (chat.chatType === 'newsletter') {
      // A channel is a broadcast feed only its owner posts to; a forward
      // into one would be refused by WhatsApp after we had already told the
      // operator it was sent.
      outcomes.push({ chatId, outboundMessageId: null, skippedReason: 'A channel cannot be sent to.' });
      continue;
    }

    try {
      const queued = await whatsappOutboundMessageService.send({
        businessId: input.businessId,
        whatsappAccountId: input.whatsappAccountId,
        chatId,
        messageType: source.messageType as 'text',
        ...(source.messageType === 'text'
          ? { text }
          : {
              mediaStorageReference: mediaStorageReference ?? undefined,
              mediaMimeType: mediaMimeType ?? undefined,
              ...(mediaFileName ? { mediaFileName } : {}),
              ...(caption ? { caption } : {}),
            }),
        requestedBy: 'human',
      });
      outcomes.push({ chatId, outboundMessageId: queued.id, skippedReason: null });
    } catch (error) {
      outcomes.push({
        chatId,
        outboundMessageId: null,
        skippedReason: error instanceof Error ? error.message : 'That send could not be queued.',
      });
    }
  }

  return outcomes;
}

export function isForwardNotPossibleError(error: unknown): error is ForwardNotPossibleError {
  return error instanceof ForwardNotPossibleError;
}
