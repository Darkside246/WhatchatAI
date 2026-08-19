import { describe, expect, it } from 'vitest';
import { WhatsAppMessageIngestionService } from '../src/services/whatsappMessageIngestionService.js';
import type { WAMessage } from '@whiskeysockets/baileys';

function upsertMessage(id: string, message: WAMessage['message']): WAMessage {
  return {
    key: { id, remoteJid: '15550001111@s.whatsapp.net', fromMe: false },
    message,
    messageTimestamp: Math.floor(Date.now() / 1000),
  } as WAMessage;
}

describe('WhatsAppMessageIngestionService content classification (real Baileys message shapes)', () => {
  it('classifies button and template-button-reply messages instead of falling to unknown', () => {
    const service = new WhatsAppMessageIngestionService();
    const [ingested] = service.ingestUpsert({
      type: 'notify',
      messages: [
        upsertMessage('BTN-1', {
          buttonsResponseMessage: { selectedButtonId: 'yes', selectedDisplayText: 'Yes please' },
        }),
      ],
    });
    expect(ingested?.contentType).toBe('button');
    expect(ingested?.textPreview).toBe('Yes please');
  });

  it('classifies list/interactive responses instead of falling to unknown', () => {
    const service = new WhatsAppMessageIngestionService();
    const [ingested] = service.ingestUpsert({
      type: 'notify',
      messages: [
        upsertMessage('LIST-1', {
          listResponseMessage: { title: 'Pickup at 5pm' },
        }),
      ],
    });
    expect(ingested?.contentType).toBe('interactive');
    expect(ingested?.textPreview).toBe('Pickup at 5pm');
  });

  it('classifies poll votes distinctly from poll creation', () => {
    const service = new WhatsAppMessageIngestionService();
    const [ingested] = service.ingestUpsert({
      type: 'notify',
      messages: [upsertMessage('POLL-VOTE-1', { pollUpdateMessage: {} })],
    });
    expect(ingested?.contentType).toBe('poll_response');
  });

  it('classifies a shared contact card array distinctly from a single contact', () => {
    const service = new WhatsAppMessageIngestionService();
    const [single] = service.ingestUpsert({
      type: 'notify',
      messages: [upsertMessage('CONTACT-1', { contactMessage: { displayName: 'Alex' } })],
    });
    const [multiple] = service.ingestUpsert({
      type: 'notify',
      messages: [upsertMessage('CONTACT-2', { contactsArrayMessage: { contacts: [] } })],
    });
    expect(single?.contentType).toBe('contact');
    expect(multiple?.contentType).toBe('contacts');
  });

  it('unwraps an edited message to classify the real underlying content', () => {
    const service = new WhatsAppMessageIngestionService();
    const [ingested] = service.ingestUpsert({
      type: 'notify',
      messages: [
        upsertMessage('EDITED-1', {
          editedMessage: { message: { conversation: 'corrected text' } },
        }),
      ],
    });
    expect(ingested?.contentType).toBe('text');
    expect(ingested?.textPreview).toBe('corrected text');
  });

  it('still honestly reports unsupported for a message with no real content (e.g. protocol-only payloads)', () => {
    const service = new WhatsAppMessageIngestionService();
    const [ingested] = service.ingestUpsert({
      type: 'notify',
      messages: [upsertMessage('EMPTY-1', {})],
    });
    expect(ingested?.contentType).toBe('unsupported');
  });
});
