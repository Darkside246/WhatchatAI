import { describe, expect, it } from 'vitest';
import { resolveDisplayName } from '../src/domain/whatsapp/displayName.js';

describe('resolveDisplayName (multi-tier real-name fallback, never fabricates a name)', () => {
  it('prefers manualDisplayName (Section 23 - a staff correction/confirmation) over every other source', () => {
    const name = resolveDisplayName({
      manualDisplayName: 'Michael Thompson',
      verifiedName: 'Acme Corp (verified)',
      businessName: 'Acme Corp',
      whatsappJid: '15550001111@s.whatsapp.net',
    });
    expect(name).toBe('Michael Thompson');
  });

  it('prefers verifiedName over every other source', () => {
    const name = resolveDisplayName({
      verifiedName: 'Acme Corp (verified)',
      businessName: 'Acme Corp',
      displayName: 'Acme',
      pushName: 'Acme Support',
      whatsappJid: '15550001111@s.whatsapp.net',
    });
    expect(name).toBe('Acme Corp (verified)');
  });

  it('falls back through businessName, displayName, pushName, shortName, phoneNumber in order', () => {
    expect(
      resolveDisplayName({ businessName: 'Acme Corp', pushName: 'ignored', whatsappJid: '15550001111@s.whatsapp.net' }),
    ).toBe('Acme Corp');
    expect(resolveDisplayName({ displayName: 'Jane Doe', pushName: 'ignored', whatsappJid: '15550001111@s.whatsapp.net' })).toBe(
      'Jane Doe',
    );
    expect(resolveDisplayName({ pushName: 'Jane', whatsappJid: '15550001111@s.whatsapp.net' })).toBe('Jane');
    expect(resolveDisplayName({ shortName: 'J', whatsappJid: '15550001111@s.whatsapp.net' })).toBe('J');
    expect(resolveDisplayName({ phoneNumber: '+15550001111', whatsappJid: '15550001111@s.whatsapp.net' })).toBe(
      '+15550001111',
    );
  });

  it('treats blank/whitespace-only strings as absent, not as a real name', () => {
    expect(resolveDisplayName({ displayName: '   ', pushName: 'Real Name', whatsappJid: '15550001111@s.whatsapp.net' })).toBe(
      'Real Name',
    );
  });

  it('falls back to the raw JID for a real, resolvable @s.whatsapp.net identity with no name at all', () => {
    expect(resolveDisplayName({ whatsappJid: '15550001111@s.whatsapp.net' })).toBe('15550001111@s.whatsapp.net');
  });

  it('formats an unresolvable @lid identity into a clean truncated label instead of the raw protocol string', () => {
    const name = resolveDisplayName({ whatsappJid: '269281631678624@lid' });
    expect(name).toBe('WhatsApp User (269281…)');
    expect(name).not.toContain('@lid');
  });

  it('still prefers any real name over the LID fallback label', () => {
    expect(resolveDisplayName({ pushName: 'Real Person', whatsappJid: '269281631678624@lid' })).toBe('Real Person');
  });
});
