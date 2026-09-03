import { describe, expect, it } from 'vitest';
import { resolveNameEvidence, shouldUseName, replyUsesName, NAME_REPETITION_COOLDOWN_MINUTES } from '../src/services/ai/identityEngine.js';

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
    const usedJustOverCooldownAgo = new Date(now.getTime() - (NAME_REPETITION_COOLDOWN_MINUTES + 1) * 60_000).toISOString();
    expect(shouldUseName({ evidence, lastNameUsedAt: usedJustOverCooldownAgo, now })).toBe('USE_NAME_NATURALLY');
  });

  it('sits exactly on the cooldown boundary as allowed (>=, not >)', () => {
    const now = new Date('2026-01-01T12:00:00Z');
    const usedExactlyAtCooldown = new Date(now.getTime() - NAME_REPETITION_COOLDOWN_MINUTES * 60_000).toISOString();
    expect(shouldUseName({ evidence, lastNameUsedAt: usedExactlyAtCooldown, now })).toBe('USE_NAME_NATURALLY');
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
