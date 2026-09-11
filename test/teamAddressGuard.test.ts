import { describe, expect, it } from 'vitest';
import { stripTeamAddress } from '../src/services/ai/teamAddressGuard.js';

/**
 * The guard has two jobs that pull against each other, and both are the
 * operator's own stated requirement: the AI must never reply to them, and
 * must still be able to tell the customer what they said. A test file that
 * only proved the first half would be describing a worse bug than the one
 * being fixed.
 */
describe('team address guard', () => {
  const team = { teamNames: ['Hasan Alkins'], customerNames: ['Julian Lashley'] };

  describe('removes a team member being addressed', () => {
    /** The exact reply that went out in production, to the wrong person. */
    it('strips a trailing vocative', () => {
      const result = stripTeamAddress('Take all the time you need, Hasan. Let me know when you are ready.', team);
      expect(result.text).toBe('Take all the time you need. Let me know when you are ready.');
      expect(result.removed).toEqual(['Hasan']);
    });

    it('strips a name after a greeting, keeping the greeting', () => {
      expect(stripTeamAddress('Hi Hasan, that is sorted now.', team).text).toBe('Hi, that is sorted now.');
      expect(stripTeamAddress('Thanks, Hasan!', team).text).toBe('Thanks!');
    });

    it('strips a leading vocative and restores the capital', () => {
      expect(stripTeamAddress('Hasan, take your time.', team).text).toBe('Take your time.');
    });

    it('strips a vocative mid-reply, at a sentence boundary', () => {
      const result = stripTeamAddress('That is done. Hasan, shall I send the invoice?', team);
      expect(result.text).toBe('That is done. Shall I send the invoice?');
    });

    it('strips the full name as one unit rather than leaving a surname behind', () => {
      const result = stripTeamAddress('No rush at all, Hasan Alkins.', team);
      expect(result.text).toBe('No rush at all.');
      expect(result.removed).toEqual(['Hasan Alkins']);
    });

    it('strips an em-dash sign-off', () => {
      expect(stripTeamAddress('All set — Hasan', team).text).toBe('All set');
    });
  });

  describe('leaves a mention of what the team member said', () => {
    /**
     * The second half of the requirement, in the operator's own words: the
     * AI "should be aware of them so they can speak about what i said to
     * the other user." Deleting every occurrence of the name would satisfy
     * the no-addressing rule by breaking this one.
     */
    it('keeps the name as a subject', () => {
      const text = 'Hasan will send that over shortly.';
      expect(stripTeamAddress(text, team)).toEqual({ text, removed: [] });
    });

    it('keeps the name as an object', () => {
      const text = 'I have asked Hasan to look at it and he is on it now.';
      expect(stripTeamAddress(text, team)).toEqual({ text, removed: [] });
    });

    it('keeps a possessive', () => {
      const text = "That is Hasan's call, and he said yes.";
      expect(stripTeamAddress(text, team)).toEqual({ text, removed: [] });
    });
  });

  describe('never fires on the customer', () => {
    /**
     * Two people can share a first name. Silently deleting a customer's own
     * name from a greeting addressed to THEM would be a worse bug than the
     * one this guard fixes, so a shared name means the guard does nothing.
     */
    it('does nothing when the customer shares the name', () => {
      const shared = { teamNames: ['Hasan Alkins'], customerNames: ['Hasan Greaves'] };
      const text = 'Take all the time you need, Hasan.';
      expect(stripTeamAddress(text, shared)).toEqual({ text, removed: [] });
    });

    it('still addresses the customer normally', () => {
      const text = 'Hi Julian, your order is ready for collection.';
      expect(stripTeamAddress(text, team)).toEqual({ text, removed: [] });
    });
  });

  describe('does not damage an ordinary reply', () => {
    const ordinary = [
      'Your order is ready for collection tomorrow.',
      'That will be $42.99 including VAT.',
      'Sure, I can check that for you. One moment.',
      'We are open 9 to 5, Monday through Friday.',
    ];

    it.each(ordinary)('leaves %j untouched', (text) => {
      expect(stripTeamAddress(text, team)).toEqual({ text, removed: [] });
    });

    it('does nothing when the business has no team names on file', () => {
      const text = 'Take all the time you need, Hasan.';
      expect(stripTeamAddress(text, { teamNames: [], customerNames: [] })).toEqual({ text, removed: [] });
    });

    it('ignores a display name that is not a real name', () => {
      const text = 'That is 247, all in.';
      expect(stripTeamAddress(text, { teamNames: ['247', '-'], customerNames: [] })).toEqual({ text, removed: [] });
    });
  });

  describe('fails safe', () => {
    /**
     * Sending an odd reply that names the wrong person is bad. Sending an
     * empty message is worse - and WhatsApp would reject it anyway. The
     * audit line still records that this happened.
     */
    it('keeps the original when stripping would leave nothing to send', () => {
      // A reply that was only a sign-off. Removing the address leaves an
      // empty string, so the original goes out instead.
      const text = '— Hasan';
      const result = stripTeamAddress(text, team);
      expect(result.text).toBe(text);
      expect(result.removed).toEqual(['Hasan']);
    });

    it('sends the remainder when a greeting is all that survives', () => {
      // Terse, but correct: "Hi" reaches the customer, and the name of
      // someone they have never heard of does not.
      expect(stripTeamAddress('Hi Hasan', team).text).toBe('Hi');
    });
  });
});
