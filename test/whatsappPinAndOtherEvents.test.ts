import { describe, expect, it } from 'vitest';
import type { WAMessage } from '@whiskeysockets/baileys';
import { WhatsAppMessageIngestionService, type IngestedWhatsAppMessage } from '../src/services/whatsappMessageIngestionService.js';

/**
 * Message types that arrive as their own top-level field rather than inside
 * a protocolMessage, and so fell past every branch of the classifier.
 *
 * Reported from a real chat: WhatsApp showed "Corey Francois pinned a
 * message" and AURA showed a bubble with nothing in it. The assertions are
 * on the wording an operator actually reads, because the content type was
 * never the part that was wrong to look at.
 */

const CUSTOMER_JID = '15550004444@s.whatsapp.net';
const ingestion = new WhatsAppMessageIngestionService();

/** proto.Message.PinInChatMessage.Type. */
const PIN_FOR_ALL = 1;
const UNPIN_FOR_ALL = 2;

function ingest(id: string, message: Record<string, unknown>): IngestedWhatsAppMessage {
  const [ingested] = ingestion.ingestUpsert({
    messages: [
      {
        key: { id, remoteJid: CUSTOMER_JID, fromMe: false },
        message,
        messageTimestamp: 1_700_000_000,
      } as unknown as WAMessage,
    ],
    type: 'notify',
  });
  if (!ingested) throw new Error('nothing was ingested');
  return ingested;
}

describe('pinning a message', () => {
  it('says a message was pinned, rather than rendering an empty bubble', () => {
    const ingested = ingest('pin-1', { pinInChatMessage: { type: PIN_FOR_ALL, key: { id: 'wamid-target' } } });

    expect(ingested.contentType).toBe('system');
    expect(ingested.textPreview).toBe('Pinned a message');
    expect(ingested.systemEvent).toEqual({ kind: 'pin', pinned: true, targetMessageId: 'wamid-target' });
  });

  it('tells an unpin apart from a pin', () => {
    const ingested = ingest('pin-2', { pinInChatMessage: { type: UNPIN_FOR_ALL, key: { id: 'wamid-target' } } });

    expect(ingested.textPreview).toBe('Unpinned a message');
    expect(ingested.systemEvent).toMatchObject({ kind: 'pin', pinned: false });
  });

  it('does not name the person, because the sender is already shown and a second lookup could name the wrong one', () => {
    expect(ingest('pin-3', { pinInChatMessage: { type: PIN_FOR_ALL } }).textPreview).not.toMatch(/pinned a message by|[A-Z][a-z]+ pinned/);
  });

  it('still reads as a pin when WhatsApp sends no target key at all', () => {
    const ingested = ingest('pin-4', { pinInChatMessage: { type: PIN_FOR_ALL } });
    expect(ingested.textPreview).toBe('Pinned a message');
    expect(ingested.systemEvent).toMatchObject({ targetMessageId: null });
  });
});

describe('keeping a message, and limiting sharing', () => {
  it('says a message was kept', () => {
    const ingested = ingest('keep-1', { keepInChatMessage: { keepType: 1, key: { id: 'wamid-kept' } } });
    expect(ingested.contentType).toBe('system');
    expect(ingested.textPreview).toBe('Kept a message in this chat');
    expect(ingested.systemEvent).toMatchObject({ kind: 'keep_in_chat', kept: true });
  });

  it('tells un-keeping apart from keeping', () => {
    const ingested = ingest('keep-2', { keepInChatMessage: { keepType: 2, key: { id: 'wamid-kept' } } });
    expect(ingested.textPreview).toBe('Stopped keeping a message');
    expect(ingested.systemEvent).toMatchObject({ kept: false });
  });

  it('describes a sharing-limit change', () => {
    expect(ingest('limit-1', { limitSharingMessage: { limitSharing: true } }).textPreview).toBe(
      'Changed who can share from this chat',
    );
  });
});

describe('media that had no branch at all', () => {
  it('treats a round video note as a video, so it can actually be played', () => {
    const ingested = ingest('ptv-1', { ptvMessage: { mimetype: 'video/mp4', mediaKey: 'k' } });
    expect(ingested.contentType).toBe('video');
    expect(ingested.mimetype).toBe('video/mp4');
  });

  it('treats an animated sticker as a sticker', () => {
    expect(ingest('lottie-1', { lottieStickerMessage: { message: {} } }).contentType).toBe('sticker');
  });
});

describe('an event created in the chat', () => {
  it('carries the event name, not just the fact that something arrived', () => {
    const ingested = ingest('event-1', { eventMessage: { name: 'Staff meeting', description: 'Back room' } });
    expect(ingested.textPreview).toBe('Event: Staff meeting - Back room');
  });

  it('says so when the event was cancelled', () => {
    expect(ingest('event-2', { eventMessage: { name: 'Staff meeting', isCanceled: true } }).textPreview).toBe(
      'Event cancelled: Staff meeting',
    );
  });
});

describe('polls from an up-to-date phone', () => {
  const options = [{ optionName: 'Yes' }, { optionName: 'No' }];

  it('reads a V5 poll, which is sent bare', () => {
    const ingested = ingest('poll-v5', { pollCreationMessageV5: { name: 'Open Sunday?', options, selectableOptionsCount: 1 } });
    expect(ingested.contentType).toBe('poll');
    expect(ingested.textPreview).toBe('Open Sunday?');
    expect(ingested.structuredPayload).toMatchObject({ kind: 'poll', options: ['Yes', 'No'] });
  });

  it('reads a V4 poll, which is wrapped in a future-proof envelope', () => {
    // The two versions are shaped differently. Guessing either way produces
    // a poll with no question and no options, and no error to notice.
    const ingested = ingest('poll-v4', {
      pollCreationMessageV4: { message: { pollCreationMessage: { name: 'Open Sunday?', options, selectableOptionsCount: 1 } } },
    });
    expect(ingested.contentType).toBe('poll');
    expect(ingested.textPreview).toBe('Open Sunday?');
    expect(ingested.structuredPayload).toMatchObject({ kind: 'poll', options: ['Yes', 'No'] });
  });
});

/**
 * Money and commerce. These matter more here than in a general chat client:
 * this app is for businesses taking payments, and a payment request arriving
 * as a blank bubble is the worst case on the whole list.
 */
describe('payments and orders', () => {
  it('carries what a payment request is actually for', () => {
    const ingested = ingest('pay-1', {
      requestPaymentMessage: {
        currencyCodeIso4217: 'BBD',
        // amount1000 is thousandths, which is WhatsApp's own unit here.
        amount1000: 25_000,
        noteMessage: { conversation: 'For the catering' },
      },
    });
    expect(ingested.textPreview).toBe('Payment requested: BBD 25.00 - For the catering');
  });

  it('still reads as a request when no amount was attached', () => {
    expect(ingest('pay-2', { requestPaymentMessage: { noteMessage: { conversation: 'Whatever you can' } } }).textPreview).toBe(
      'Payment requested - Whatever you can',
    );
  });

  it('says a payment was sent, never that it was received', () => {
    // What reaches us is the customer's claim. Turning a claim into a
    // receipt is how a business gives away an order's worth of food.
    const ingested = ingest('pay-3', { sendPaymentMessage: { noteMessage: { conversation: 'Sent it' } } });
    expect(ingested.textPreview).toBe('Payment sent - Sent it');
    expect(ingested.textPreview).not.toMatch(/paid|received|confirmed/i);
  });

  it('tells a cancelled request apart from a declined one', () => {
    expect(ingest('pay-4', { cancelPaymentRequestMessage: { key: {} } }).textPreview).toBe('Payment request cancelled');
    expect(ingest('pay-5', { declinePaymentRequestMessage: { key: {} } }).textPreview).toBe('Payment request declined');
  });

  it('carries an order title and how many items are in it', () => {
    const ingested = ingest('order-1', { orderMessage: { orderTitle: 'Saturday lunch', itemCount: 3, message: 'No onions' } });
    expect(ingested.textPreview).toBe('Order: Saturday lunch - 3 items - No onions');
  });

  it('says one item rather than 1 items', () => {
    expect(ingest('order-2', { orderMessage: { orderTitle: 'Coffee', itemCount: 1 } }).textPreview).toBe('Order: Coffee - 1 item');
  });

  it('names the product somebody sent from a catalogue', () => {
    expect(ingest('prod-1', { productMessage: { product: { title: 'Fish cutter' } } }).textPreview).toBe('Product: Fish cutter');
  });
});

describe('albums and number requests', () => {
  it('says how much is coming in an album', () => {
    expect(ingest('album-1', { albumMessage: { expectedImageCount: 4, expectedVideoCount: 1 } }).textPreview).toBe(
      'Album - 4 photos, 1 video',
    );
  });

  it('leaves out the half that is empty', () => {
    expect(ingest('album-2', { albumMessage: { expectedImageCount: 2 } }).textPreview).toBe('Album - 2 photos');
  });

  it('describes a request to share a phone number', () => {
    expect(ingest('phone-1', { requestPhoneNumberMessage: {} }).textPreview).toBe('Asked to share a phone number');
  });
});
