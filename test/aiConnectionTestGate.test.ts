import { describe, expect, it } from 'vitest';
import { checkAiConnectionTestGate, AI_TEST_CONNECTION_COOLDOWN_MS } from '../src/services/ai/aiConnectionTestGate.js';

describe('checkAiConnectionTestGate (AI Agents Page Consolidation - 15-minute rate limit)', () => {
  it('allows a business that has never tested before', () => {
    expect(checkAiConnectionTestGate(null)).toEqual({ allowed: true });
  });

  it('denies a second test inside the 15-minute cooldown, with a real retryAfterSeconds', () => {
    const now = new Date('2026-01-01T12:00:00Z');
    const testedOneMinuteAgo = new Date(now.getTime() - 60_000);
    const result = checkAiConnectionTestGate(testedOneMinuteAgo, now);
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.retryAfterSeconds).toBe(14 * 60);
  });

  it('allows a test again once the full cooldown has elapsed', () => {
    const now = new Date('2026-01-01T12:00:00Z');
    const testedJustOverCooldownAgo = new Date(now.getTime() - (AI_TEST_CONNECTION_COOLDOWN_MS + 1000));
    expect(checkAiConnectionTestGate(testedJustOverCooldownAgo, now)).toEqual({ allowed: true });
  });

  it('sits exactly on the cooldown boundary as allowed (>=, not >)', () => {
    const now = new Date('2026-01-01T12:00:00Z');
    const testedExactlyAtCooldown = new Date(now.getTime() - AI_TEST_CONNECTION_COOLDOWN_MS);
    expect(checkAiConnectionTestGate(testedExactlyAtCooldown, now)).toEqual({ allowed: true });
  });
});
