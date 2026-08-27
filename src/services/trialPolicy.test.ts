import { describe, expect, it } from 'vitest';
import { createTrialTiming, deriveTrialState, normalizeTrialEmail, TRIAL_DURATION_MS, TRIAL_EXPIRING_THRESHOLD_MS, canUseProductAccount } from './trialPolicy.js';

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

  it('never grants operational access after expiry or restriction', () => {
    const ends = new Date(now.getTime() + 1000);
    expect(canUseProductAccount('ACTIVE', 'ACTIVE', now, ends)).toBe(true);
    expect(canUseProductAccount('EXPIRED', 'ACTIVE', new Date(now.getTime() + 2000), ends)).toBe(false);
    expect(canUseProductAccount('ACTIVE', 'RESTRICTED', now, ends)).toBe(false);
  });

  it('keeps converted subscriptions active independently of the trial clock', () => {
    expect(canUseProductAccount('CONVERTED', 'ACTIVE', new Date('2030-01-01T00:00:00.000Z'), null)).toBe(true);
  });
});
