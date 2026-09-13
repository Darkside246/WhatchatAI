import { describe, expect, it } from 'vitest';
import type { WAMessage } from '@whiskeysockets/baileys';
import {
  WhatsAppMessageIngestionService,
  isConversationalMessage,
  type IngestedWhatsAppMessage,
} from '../src/services/whatsappMessageIngestionService.js';

/**
 * The messages that come up as the bare word "Message".
 *
 * WhatsApp has around ninety message types and this app understands about
 * half of them; the rest fall to a fallback that renders as "Message". That
 * is honest, but until now it was also a dead end - nobody could tell WHICH
 * type any particular one had been, so the only way to find out was to
 * guess and deploy again.
 *
 * Two changes, pinned here. WhatsApp's own transport metadata is dropped
 * rather than shown, because the official client shows it to nobody. And
 * anything genuinely unrecognised records its protobuf field name, so the
 * next report of "some messages just say Message" is a query rather than a
 * guessing game.
 */

const CUSTOMER_JID = '15550002222@s.whatsapp.net';
const ingestion = new WhatsAppMessageIngestionService();

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

describe("WhatsApp's own transport metadata", () => {
  it('drops an envelope that carries nothing but the device-list blob', () => {
    // messageContextInfo rides along with ordinary sends and occasionally
    // arrives alone. The official client shows it to nobody; showing it
    // put an empty bubble in the middle of a real conversation.
    const ingested = ingest('ctx-1', { messageContextInfo: { deviceListMetadataVersion: 2 } });
    expect(isConversationalMessage(ingested)).toBe(false);
  });

  it('drops a bare group key distribution', () => {
    expect(isConversationalMessage(ingest('skdm-1', { senderKeyDistributionMessage: { groupId: 'g@g.us' } }))).toBe(false);
  });

  it('does NOT drop a real message that happens to carry it alongside', () => {
    // This is the case that makes "is it present" the wrong test and "is
    // it the only thing here" the right one: both of these ride with
    // ordinary content constantly, and dropping those would delete real
    // messages wholesale.
    const ingested = ingest('ctx-2', {
      conversation: 'are you open tomorrow?',
      messageContextInfo: { deviceListMetadataVersion: 2 },
    });
    expect(isConversationalMessage(ingested)).toBe(true);
    expect(ingested.textPreview).toBe('are you open tomorrow?');
  });

  it('does not drop a group message that carries the key with real content', () => {
    const ingested = ingest('skdm-2', {
      conversation: 'two large fries please',
      senderKeyDistributionMessage: { groupId: 'g@g.us' },
    });
    expect(isConversationalMessage(ingested)).toBe(true);
    expect(ingested.contentType).toBe('text');
  });
});

describe('a type this app has not learned yet', () => {
  it('records which type it was, so the next report is a query and not a guess', () => {
    const ingested = ingest('poll-snap-1', { pollResultSnapshotMessage: { name: 'Open Sunday?' } });
    expect(ingested.contentType).toBe('unsupported');
    expect(ingested.unsupportedField).toBe('pollResultSnapshotMessage');
  });

  it('names the real type even when transport metadata is riding along', () => {
    const ingested = ingest('poll-snap-2', {
      messageContextInfo: { deviceListMetadataVersion: 2 },
      scheduledCallCreationMessage: { scheduledTimestampMs: 1 },
    });
    expect(ingested.unsupportedField).toBe('scheduledCallCreationMessage');
  });

  it('still reaches the operator rather than being swallowed', () => {
    // An unknown type is shown, not dropped. Dropping it would be the same
    // mistake as the Sentinel's: a message nobody can see is worse than an
    // ugly one.
    expect(isConversationalMessage(ingest('unknown-1', { invoiceMessage: { note: 'x' } }))).toBe(true);
  });

  it('leaves unsupportedField null on everything it does understand', () => {
    expect(ingest('text-1', { conversation: 'hello' }).unsupportedField).toBeNull();
    expect(ingest('img-1', { imageMessage: { mimetype: 'image/jpeg' } }).unsupportedField).toBeNull();
  });
});

/** proto.Message.ProtocolMessage.Type.MESSAGE_EDIT. */
const MESSAGE_EDIT = 14;

describe('correcting a caption', () => {
  it('reads the new words off an edited photo caption', () => {
    // An edit is not only ever an edit of plain text. Reading only the two
    // text shapes meant a caption correction was acknowledged and then
    // never applied - the chat kept showing the words the customer had
    // already replaced, with nothing to suggest anything had happened.
    const ingested = ingest('edit-1', {
      protocolMessage: {
        type: MESSAGE_EDIT,
        key: { id: 'wamid-photo' },
        editedMessage: { imageMessage: { caption: 'sorry - no onions on that one' } },
      },
    });

    expect(ingested.systemEvent).toEqual({
      kind: 'edit',
      targetMessageId: 'wamid-photo',
      newText: 'sorry - no onions on that one',
    });
  });

  it('reads an edited video caption and an edited document caption', () => {
    const video = ingest('edit-2', {
      protocolMessage: { type: MESSAGE_EDIT, key: { id: 'v' }, editedMessage: { videoMessage: { caption: 'this one' } } },
    });
    const document = ingest('edit-3', {
      protocolMessage: { type: MESSAGE_EDIT, key: { id: 'd' }, editedMessage: { documentMessage: { caption: 'the right menu' } } },
    });

    expect(video.systemEvent).toMatchObject({ newText: 'this one' });
    expect(document.systemEvent).toMatchObject({ newText: 'the right menu' });
  });

  it('still reads an ordinary text edit', () => {
    const ingested = ingest('edit-4', {
      protocolMessage: { type: MESSAGE_EDIT, key: { id: 't' }, editedMessage: { conversation: 'make that three' } },
    });
    expect(ingested.systemEvent).toMatchObject({ kind: 'edit', newText: 'make that three' });
  });
});
