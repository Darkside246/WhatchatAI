import { describe, expect, it } from 'vitest';
import {
  resolveBusinessTimezone,
  resolveCustomerTimezone,
  resolveUserTimezone,
  SYSTEM_FALLBACK_TIMEZONE,
} from '../../src/services/time/timeZoneResolver.js';

describe('resolveBusinessTimezone', () => {
  it('uses the explicit business timezone when valid', () => {
    expect(resolveBusinessTimezone({ timezone: 'Europe/London' })).toBe('Europe/London');
  });

  it('falls back to the system default when the stored value is not a real IANA zone', () => {
    expect(resolveBusinessTimezone({ timezone: 'Not/ARealZone' })).toBe(SYSTEM_FALLBACK_TIMEZONE);
  });

  it('falls back to the system default when nothing is set', () => {
    expect(resolveBusinessTimezone({ timezone: null })).toBe(SYSTEM_FALLBACK_TIMEZONE);
  });
});

describe('resolveUserTimezone (priority: explicit -> browser/device -> account default -> system fallback)', () => {
  it('prefers an explicit user preference over everything else', () => {
    const result = resolveUserTimezone({ explicitTimezone: 'Asia/Tokyo', browserTimezone: 'Europe/Paris' }, 'America/Chicago');
    expect(result).toBe('Asia/Tokyo');
  });

  it('falls back to the browser/device timezone when no explicit preference is set', () => {
    const result = resolveUserTimezone({ explicitTimezone: null, browserTimezone: 'Europe/Paris' }, 'America/Chicago');
    expect(result).toBe('Europe/Paris');
  });

  it('falls back to the account (business) default when neither explicit nor browser timezone is known', () => {
    const result = resolveUserTimezone({}, 'America/Chicago');
    expect(result).toBe('America/Chicago');
  });

  it('skips an invalid explicit value rather than trusting it blindly', () => {
    const result = resolveUserTimezone({ explicitTimezone: 'Bogus/Zone', browserTimezone: 'Europe/Paris' }, 'America/Chicago');
    expect(result).toBe('Europe/Paris');
  });
});

describe('resolveCustomerTimezone (priority: explicit -> location-derived -> business default -> system fallback)', () => {
  it('prefers an explicit customer timezone', () => {
    expect(resolveCustomerTimezone({ explicitTimezone: 'Asia/Karachi' }, 'UTC')).toBe('Asia/Karachi');
  });

  it('falls back to a location-derived timezone when no explicit one is set', () => {
    expect(resolveCustomerTimezone({ locationDerivedTimezone: 'America/Barbados' }, 'UTC')).toBe('America/Barbados');
  });

  it('falls back to the business default today, since no per-contact timezone signal exists yet', () => {
    expect(resolveCustomerTimezone({}, 'America/Los_Angeles')).toBe('America/Los_Angeles');
  });
});
