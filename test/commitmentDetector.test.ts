import { describe, expect, it } from 'vitest';
import { detectCommitmentPhrase } from '../src/services/commitmentDetector.js';

describe('detectCommitmentPhrase (real deterministic phrase matching, no AI call)', () => {
  it('detects a real "I\'ll follow up" style promise', () => {
    expect(detectCommitmentPhrase("No problem, I'll follow up with the vendor and let you know.")).not.toBeNull();
  });

  it('detects "let me check" and "get back to you"', () => {
    expect(detectCommitmentPhrase('Let me check on that for you.')).not.toBeNull();
    expect(detectCommitmentPhrase("I'll get back to you shortly with an answer.")).not.toBeNull();
  });

  it('detects the exact pending_approval wording used elsewhere in this codebase', () => {
    expect(detectCommitmentPhrase('Let me check with the team and confirm shortly.')).not.toBeNull();
  });

  it('detects "someone will reach out"', () => {
    expect(detectCommitmentPhrase('Thanks for reporting that - someone will reach out within the hour.')).not.toBeNull();
  });

  it('does not flag an ordinary informational reply with no promise', () => {
    expect(detectCommitmentPhrase('Our office hours are 9am to 5pm, Monday to Friday.')).toBeNull();
    expect(detectCommitmentPhrase('The unit has two bedrooms and one bathroom.')).toBeNull();
    expect(detectCommitmentPhrase('Yes, that works for me!')).toBeNull();
  });

  it('does not flag a real completed booking confirmation as a pending commitment', () => {
    expect(detectCommitmentPhrase("You're all set - I've booked your viewing for 3pm tomorrow.")).toBeNull();
  });

  it('is case-insensitive', () => {
    expect(detectCommitmentPhrase("I'LL FOLLOW UP TOMORROW.")).not.toBeNull();
  });
});
