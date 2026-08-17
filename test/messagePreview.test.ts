import { describe, expect, it } from 'vitest';
import { describeMessageType } from '../src/domain/whatsapp/messagePreview.js';
import type { MessageType } from '../src/domain/whatsapp/types.js';

const ALL_TYPES: MessageType[] = [
  'text',
  'image',
  'audio',
  'voice_note',
  'video',
  'document',
  'spreadsheet',
  'sticker',
  'location',
  'contact',
  'contacts',
  'reaction',
  'poll',
  'poll_response',
  'button',
  'interactive',
  'system',
  'call_event',
  'unknown',
];

describe('describeMessageType (real human-readable chat-list preview labels)', () => {
  it('never returns the raw bracketed internal type name for any real message type', () => {
    for (const type of ALL_TYPES) {
      const label = describeMessageType(type);
      expect(label).not.toBe(`[${type}]`);
      expect(label.length).toBeGreaterThan(0);
    }
  });

  it('gives system and unknown honest, non-alarming labels', () => {
    expect(describeMessageType('system')).toBe('System message');
    expect(describeMessageType('unknown')).toBe('Message');
  });

  it('gives media types their real, specific label', () => {
    expect(describeMessageType('image')).toBe('Photo');
    expect(describeMessageType('voice_note')).toBe('Voice message');
    expect(describeMessageType('document')).toBe('Document');
  });
});
