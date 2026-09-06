import { describe, expect, it } from 'vitest';
import { computeTypingDelayMs } from '../src/services/humanlikeTypingDelay.js';

describe('computeTypingDelayMs', () => {
  it('never returns an instant (zero or near-zero) delay, even for a very short reply', () => {
    expect(computeTypingDelayMs('Ok!')).toBeGreaterThanOrEqual(800);
  });

  it('scales up for a longer reply', () => {
    const short = computeTypingDelayMs('Sure, one moment.');
    const long = computeTypingDelayMs(
      'Sure, let me check on that for you - it might take a moment since I want to make sure I give you the correct answer rather than guessing.',
    );
    expect(long).toBeGreaterThan(short);
  });

  it('caps at a real maximum regardless of how long the reply is', () => {
    const veryLong = 'a'.repeat(5000);
    expect(computeTypingDelayMs(veryLong)).toBeLessThanOrEqual(8_000);
  });

  it('is deterministic - the same text always produces the same delay', () => {
    const text = 'The same input should never produce a different delay on repeated calls.';
    expect(computeTypingDelayMs(text)).toBe(computeTypingDelayMs(text));
  });
});
