import { describe, expect, it } from 'vitest';
import { createTrialTiming, deriveTrialState, normalizeTrialEmail, TRIAL_DURATION_MS, TRIAL_EXPIRING_THRESHOLD_MS } from './trialPolicy.js';

describe('trial policy', () => {
  const now = new Date('2026-08-27T00:00:00.000Z');

  it('normalises email identity before trial eligibility is checked', () => {
    expect(normalizeTrialEmail('  TEST@Example.COM ')).toBe('test@example.com');
  });

  it('creates exactly a 48-hour window', () => {
    const timing = createTrialTiming(now);
    expect(timing.state).toBe('ACTIVE');
    expect(timing.endsAt!.getTime() - timing.startsAt!.getTime()).toBe(TRIAL_DURATION_MS);
  });

  it('moves active trials to expiring and then expired', () => {
    const timing = createTrialTiming(now);
    expect(deriveTrialState(timing, new Date(timing.endsAt!.getTime() - TRIAL_EXPIRING_THRESHOLD_MS))).toBe('EXPIRING');
    expect(deriveTrialState(timing, timing.endsAt!)).toBe('EXPIRED');
  });
});
