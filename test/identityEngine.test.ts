import { describe, expect, it } from 'vitest';
import { resolveNameEvidence, shouldUseName, replyUsesName, customerAskedToUseName, NAME_USAGE_COOLDOWN_MINUTES, DEFAULT_NAME_USAGE_LEVEL } from '../src/services/ai/identityEngine.js';

const NATURAL_COOLDOWN_MINUTES = NAME_USAGE_COOLDOWN_MINUTES[DEFAULT_NAME_USAGE_LEVEL]!;

describe('resolveNameEvidence (Section 15/16 - name source hierarchy)', () => {
  it('prefers a staff-confirmed name (Section 23) over every other source, including the customer\'s own self-reported preferred name', () => {
    const evidence = resolveNameEvidence({
      staffConfirmedName: 'Michael',
      confirmedPreferredName: 'Mike',
      verifiedName: 'M. Thompson',
      pushName: 'MikeT99',
    });
    expect(evidence).toEqual({ name: 'Michael', confidence: 'STAFF_CONFIRMED_NAME' });
  });

  it('prefers a confirmed preferred name over every other source', () => {
    const evidence = resolveNameEvidence({ confirmedPreferredName: 'Mike', verifiedName: 'Michael Thompson', pushName: 'MikeT99' });
    expect(evidence).toEqual({ name: 'Mike', confidence: 'CONFIRMED_PREFERRED_NAME' });
  });

  it('falls back through the hierarchy when higher tiers are absent', () => {
    expect(resolveNameEvidence({ verifiedName: 'Michael Thompson', pushName: 'MikeT99' })).toEqual({ name: 'Michael Thompson', confidence: 'LIKELY_REAL_NAME' });
    expect(resolveNameEvidence({ pushName: 'MikeT99' })).toEqual({ name: 'MikeT99', confidence: 'POSSIBLE_REAL_NAME' });
    expect(resolveNameEvidence({ username: 'mike.t' })).toEqual({ name: 'mike.t', confidence: 'USERNAME' });
    expect(resolveNameEvidence({ shortName: 'Mikey' })).toEqual({ name: 'Mikey', confidence: 'NICKNAME' });
    expect(resolveNameEvidence({ businessName: "Mike's Plumbing" })).toEqual({ name: "Mike's Plumbing", confidence: 'BUSINESS_NAME' });
  });

  it('never assumes a WhatsApp display name is a real name just because it looks like one - it is still only POSSIBLE_REAL_NAME, not LIKELY or CONFIRMED', () => {
    const evidence = resolveNameEvidence({ pushName: 'John Smith' });
    expect(evidence?.confidence).toBe('POSSIBLE_REAL_NAME');
  });

  it('returns null when nothing real is known - never fabricates a name from a phone number', () => {
    expect(resolveNameEvidence({})).toBeNull();
  });

  it('treats a blank/whitespace-only source as absent, not a real name', () => {
    expect(resolveNameEvidence({ confirmedPreferredName: '   ', pushName: 'Real Push Name' })).toEqual({ name: 'Real Push Name', confidence: 'POSSIBLE_REAL_NAME' });
  });

  it('treats a blank/whitespace-only staff-confirmed name as absent too, falling through to the next real tier', () => {
    expect(resolveNameEvidence({ staffConfirmedName: '   ', confirmedPreferredName: 'Mike' })).toEqual({ name: 'Mike', confidence: 'CONFIRMED_PREFERRED_NAME' });
  });
});

describe('shouldUseName (Section 18/19 - usage algorithm + repetition protection)', () => {
  const evidence = { name: 'Mike', confidence: 'CONFIRMED_PREFERRED_NAME' as const };

  it('never uses a name when there is no real evidence for one', () => {
    expect(shouldUseName({ evidence: null, lastNameUsedAt: null })).toBe('DO_NOT_USE_NAME');
  });

  it('uses the name naturally the first time in a conversation', () => {
    expect(shouldUseName({ evidence, lastNameUsedAt: null })).toBe('USE_NAME_NATURALLY');
  });

  it('withholds the name immediately after it was just used (inside the cooldown)', () => {
    const now = new Date('2026-01-01T12:00:00Z');
    const usedOneMinuteAgo = new Date(now.getTime() - 60_000).toISOString();
    expect(shouldUseName({ evidence, lastNameUsedAt: usedOneMinuteAgo, now })).toBe('DO_NOT_USE_NAME');
  });

  it('allows the name again once the cooldown has fully elapsed', () => {
    const now = new Date('2026-01-01T12:00:00Z');
    const usedJustOverCooldownAgo = new Date(now.getTime() - (NATURAL_COOLDOWN_MINUTES + 1) * 60_000).toISOString();
    expect(shouldUseName({ evidence, lastNameUsedAt: usedJustOverCooldownAgo, now })).toBe('USE_NAME_NATURALLY');
  });

  it('sits exactly on the cooldown boundary as allowed (>=, not >)', () => {
    const now = new Date('2026-01-01T12:00:00Z');
    const usedExactlyAtCooldown = new Date(now.getTime() - NATURAL_COOLDOWN_MINUTES * 60_000).toISOString();
    expect(shouldUseName({ evidence, lastNameUsedAt: usedExactlyAtCooldown, now })).toBe('USE_NAME_NATURALLY');
  });

  describe('Section 19 (important-moment cooldown override)', () => {
    it('bypasses an active cooldown when customerReadiness is URGENT', () => {
      const now = new Date('2026-01-01T12:00:00Z');
      const usedOneMinuteAgo = new Date(now.getTime() - 60_000).toISOString();
      expect(shouldUseName({ evidence, lastNameUsedAt: usedOneMinuteAgo, now, customerReadiness: 'URGENT' })).toBe('USE_NAME_NATURALLY');
    });

    it('does not bypass the cooldown for any other readiness level - a genuine exception, not a broadened one', () => {
      const now = new Date('2026-01-01T12:00:00Z');
      const usedOneMinuteAgo = new Date(now.getTime() - 60_000).toISOString();
      for (const readiness of ['NOT_READY', 'BROWSING', 'NEEDS_INFORMATION', 'COMPARING', 'INTERESTED', 'HIGHLY_INTERESTED', 'READY_TO_ACT'] as const) {
        expect(shouldUseName({ evidence, lastNameUsedAt: usedOneMinuteAgo, now, customerReadiness: readiness })).toBe('DO_NOT_USE_NAME');
      }
    });

    it('still requires real name evidence - URGENT alone never fabricates a name to use', () => {
      expect(shouldUseName({ evidence: null, lastNameUsedAt: null, customerReadiness: 'URGENT' })).toBe('DO_NOT_USE_NAME');
    });

    it('is a no-op when customerReadiness is omitted - every pre-existing caller is unaffected', () => {
      const now = new Date('2026-01-01T12:00:00Z');
      const usedOneMinuteAgo = new Date(now.getTime() - 60_000).toISOString();
      expect(shouldUseName({ evidence, lastNameUsedAt: usedOneMinuteAgo, now })).toBe('DO_NOT_USE_NAME');
    });
  });

  describe('Personalisation Budget (directive §27 - configurable 5-level cooldown)', () => {
    it('defaults to level 3 (Natural, 15 minutes) when nameUsageLevel is omitted - every pre-existing caller unaffected', () => {
      const now = new Date('2026-01-01T12:00:00Z');
      const used14MinutesAgo = new Date(now.getTime() - 14 * 60_000).toISOString();
      const used16MinutesAgo = new Date(now.getTime() - 16 * 60_000).toISOString();
      expect(shouldUseName({ evidence, lastNameUsedAt: used14MinutesAgo, now })).toBe('DO_NOT_USE_NAME');
      expect(shouldUseName({ evidence, lastNameUsedAt: used16MinutesAgo, now })).toBe('USE_NAME_NATURALLY');
    });

    it.each([
      [1, 60],
      [2, 30],
      [3, 15],
      [4, 5],
      [5, 0],
    ])('level %i maps to a real %i-minute cooldown', (level, minutes) => {
      const now = new Date('2026-01-01T12:00:00Z');
      const justUnder = minutes > 0 ? new Date(now.getTime() - (minutes - 1) * 60_000).toISOString() : null;
      const justAtOrOver = new Date(now.getTime() - minutes * 60_000).toISOString();

      if (justUnder) {
        expect(shouldUseName({ evidence, lastNameUsedAt: justUnder, now, nameUsageLevel: level })).toBe('DO_NOT_USE_NAME');
      }
      expect(shouldUseName({ evidence, lastNameUsedAt: justAtOrOver, now, nameUsageLevel: level })).toBe('USE_NAME_NATURALLY');
    });

    it('level 5 (Very frequent) has a zero cooldown - real evidence is used every turn, never withheld for repetition alone', () => {
      const now = new Date('2026-01-01T12:00:00Z');
      const usedOneSecondAgo = new Date(now.getTime() - 1_000).toISOString();
      expect(shouldUseName({ evidence, lastNameUsedAt: usedOneSecondAgo, now, nameUsageLevel: 5 })).toBe('USE_NAME_NATURALLY');
    });

    it('never fabricates a name at any level - no real evidence still means no name, regardless of how permissive the level is', () => {
      expect(shouldUseName({ evidence: null, lastNameUsedAt: null, nameUsageLevel: 5 })).toBe('DO_NOT_USE_NAME');
    });

    it('URGENT readiness still bypasses the cooldown at every level, not only the default', () => {
      const now = new Date('2026-01-01T12:00:00Z');
      const usedOneMinuteAgo = new Date(now.getTime() - 60_000).toISOString();
      for (const level of [1, 2, 3, 4, 5]) {
        expect(shouldUseName({ evidence, lastNameUsedAt: usedOneMinuteAgo, now, nameUsageLevel: level, customerReadiness: 'URGENT' })).toBe('USE_NAME_NATURALLY');
      }
    });
  });

  describe('master on/off switch (nameUsageEnabled) - "off unless the customer asks"', () => {
    it('is a no-op when omitted - every pre-existing caller keeps its original, enabled behavior', () => {
      expect(shouldUseName({ evidence, lastNameUsedAt: null })).toBe('USE_NAME_NATURALLY');
    });

    it('withholds the name outright when disabled, even on the very first message of a conversation', () => {
      expect(shouldUseName({ evidence, lastNameUsedAt: null, nameUsageEnabled: false })).toBe('DO_NOT_USE_NAME');
    });

    it('withholds the name when disabled regardless of URGENT readiness - the ask carve-out is the only exception, not the important-moment one', () => {
      expect(shouldUseName({ evidence, lastNameUsedAt: null, nameUsageEnabled: false, customerReadiness: 'URGENT' })).toBe('DO_NOT_USE_NAME');
    });

    it('uses the name for this one reply when disabled but the customer explicitly asked', () => {
      expect(shouldUseName({ evidence, lastNameUsedAt: null, nameUsageEnabled: false, customerAskedForName: true })).toBe('USE_NAME_NATURALLY');
    });

    it('never fabricates a name even when disabled-but-asked - real evidence is still required', () => {
      expect(shouldUseName({ evidence: null, lastNameUsedAt: null, nameUsageEnabled: false, customerAskedForName: true })).toBe('DO_NOT_USE_NAME');
    });

    it('an explicit true behaves identically to omitted (the default)', () => {
      expect(shouldUseName({ evidence, lastNameUsedAt: null, nameUsageEnabled: true })).toBe('USE_NAME_NATURALLY');
    });
  });
});

describe('customerAskedToUseName (deterministic ask detection - the one carve-out when name usage is off)', () => {
  it('detects common phrasings of an explicit request to be addressed by name', () => {
    expect(customerAskedToUseName('Please call me by my name from now on')).toBe(true);
    expect(customerAskedToUseName('can you use my name please')).toBe(true);
    expect(customerAskedToUseName('Feel free to say my name')).toBe(true);
    expect(customerAskedToUseName('Could you address me properly')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(customerAskedToUseName('CALL ME by my name')).toBe(true);
  });

  it('does not false-positive on ordinary messages that never ask for this', () => {
    expect(customerAskedToUseName('What time do you close today?')).toBe(false);
    expect(customerAskedToUseName('My name is Michael')).toBe(false);
  });
});

describe('replyUsesName (deterministic post-hoc detection)', () => {
  const evidence = { name: 'Ann', confidence: 'CONFIRMED_PREFERRED_NAME' as const };

  it('detects the name when it genuinely appears in the reply', () => {
    expect(replyUsesName('Sure thing, Ann - I can help with that.', evidence)).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(replyUsesName('sure, ann, no problem', evidence)).toBe(true);
  });

  it('does not false-positive on a name that is a substring of a different word', () => {
    expect(replyUsesName('Happy anniversary! Hope your Anniversary trip goes well.', evidence)).toBe(false);
  });

  it('returns false when there is no evidence to check against', () => {
    expect(replyUsesName('Hi Ann, how can I help?', null)).toBe(false);
  });

  it('never throws on a name containing regex-special characters', () => {
    const weirdEvidence = { name: 'O\'Brien', confidence: 'POSSIBLE_REAL_NAME' as const };
    expect(() => replyUsesName("Thanks, O'Brien!", weirdEvidence)).not.toThrow();
    expect(replyUsesName("Thanks, O'Brien!", weirdEvidence)).toBe(true);
  });
});
