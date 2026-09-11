import { describe, expect, it } from 'vitest';
import { detectPii, describePiiFindings } from '../src/web/src/lib/piiDetector.js';

/**
 * The detector is a browser-side warning, but it is tested here with the rest
 * of the suite because what it does and does not catch is a real privacy
 * claim. A false negative means personal information reaches an AI provider
 * without the operator being asked; a false positive trains people to click
 * through the warning, which is worse than not having it.
 */
describe('operator PII warning', () => {
  describe('catches what it claims to', () => {
    const cases: [string, string][] = [
      ['call me on 246-555-1234', 'a phone number'],
      ['email julian@example.com for the invoice', 'an email address'],
      ['card 4111 1111 1111 1111', 'a payment card number'],
      ['passport number A1234567', 'a government ID number'],
      ['use api_keyABCDEFGHIJKLMNOP123', 'an API key or access token'],
    ];

    it.each(cases)('flags %j', (text, expected) => {
      const findings = detectPii(text);
      expect(findings.map((finding) => finding.label)).toContain(expected);
    });

    it('reports each kind once, however many times it appears', () => {
      const findings = detectPii('mail a@b.com or c@d.com or e@f.com');
      expect(findings.filter((finding) => finding.kind === 'email')).toHaveLength(1);
    });

    it('reports several different kinds together', () => {
      const findings = detectPii('julian@example.com, 246-555-1234');
      expect(findings.map((f) => f.kind).sort()).toEqual(['email', 'phone']);
      expect(describePiiFindings(findings)).toBe('an email address and a phone number');
    });
  });

  describe('does not cry wolf', () => {
    /**
     * Every false positive here would fire on ordinary business messages. An
     * operator who sees the warning on "your order is ready" learns to click
     * through it, and then it fails on the message that mattered.
     */
    const ordinary = [
      'Your order is ready for collection tomorrow.',
      'That will be $42.99 including VAT.',
      'We are open 9 to 5 Monday through Friday.',
      'Order 1234567890123456 shipped today.',
      'Invoice 4402 is attached.',
      'We have been trading since 1998.',
    ];

    it.each(ordinary)('stays quiet on %j', (text) => {
      expect(detectPii(text)).toEqual([]);
    });

    it('does not mistake a long reference number for a payment card', () => {
      // Fails Luhn, so it is a reference number rather than a card.
      expect(detectPii('order 1234567890123456').map((f) => f.kind)).not.toContain('card');
    });

    it('does not treat a bare price or year as a phone number', () => {
      expect(detectPii('that is 2024 dollars')).toEqual([]);
    });
  });

  describe('never repeats the value back', () => {
    /**
     * The notice names the KIND, never the match. The operator can already
     * see their own text in the composer; echoing a card number into a second
     * element only spreads it - into the DOM, and into any screenshot of the
     * warning.
     */
    it('describes findings without quoting the matched text', () => {
      const secret = '4111 1111 1111 1111';
      const described = describePiiFindings(detectPii(`pay with ${secret}`));
      expect(described).toBe('a payment card number');
      expect(described).not.toContain('4111');
    });
  });

  it('returns nothing for empty or whitespace-only text', () => {
    expect(detectPii('')).toEqual([]);
    expect(detectPii('   \n  ')).toEqual([]);
    expect(describePiiFindings([])).toBe('');
  });
});
