import { describe, expect, it } from 'vitest';
import { classifyJid, derivePhoneNumber } from '../src/domain/whatsapp/jid.js';

describe('JID classification and phone derivation', () => {
  it('classifies a phone-based individual JID', () => {
    expect(classifyJid('15550001111@s.whatsapp.net')).toBe('individual');
  });

  it('classifies a @lid JID distinctly from individual', () => {
    expect(classifyJid('234471341175024@lid')).toBe('lid');
  });

  it('classifies a group JID', () => {
    expect(classifyJid('12345-67890@g.us')).toBe('group');
  });

  it('derives a real phone number from a phone-based JID', () => {
    expect(derivePhoneNumber('15550001111@s.whatsapp.net', 'individual', null)).toBe('+15550001111');
  });

  it('NEVER derives a phone number from a @lid JID digits (regression: the old @lid bug)', () => {
    // The local part looks numeric, but it is a linked-device id, not a phone number.
    expect(derivePhoneNumber('234471341175024@lid', 'lid', null)).toBeNull();
  });

  it('derives a phone number from a @lid JID only via a genuine Baileys remoteJidAlt mapping', () => {
    expect(derivePhoneNumber('234471341175024@lid', 'lid', '12462451422@s.whatsapp.net')).toBe('+12462451422');
  });

  it('ignores a remoteJidAlt that is not itself a phone-based JID', () => {
    expect(derivePhoneNumber('234471341175024@lid', 'lid', '999@lid')).toBeNull();
  });

  it('never returns a phone number for a group JID', () => {
    expect(derivePhoneNumber('12345-67890@g.us', 'group', null)).toBeNull();
  });
});
