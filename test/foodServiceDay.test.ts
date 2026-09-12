import { describe, expect, it } from 'vitest';
import { currentServiceDay, serviceDayBounds } from '../src/domain/food/serviceDay.js';

/**
 * A kitchen that closes at one in the morning has ONE service. A summary
 * that cuts it at midnight UTC splits a Friday night across two reports and
 * agrees with neither.
 */
describe('a restaurant day', () => {
  it('brackets a Barbados day in UTC', () => {
    const { from, to } = serviceDayBounds('2026-09-11', 'America/Barbados');
    // Barbados is UTC-4 year round, so local midnight is 04:00 UTC.
    expect(from.toISOString()).toBe('2026-09-11T04:00:00.000Z');
    expect(to.toISOString()).toBe('2026-09-12T04:00:00.000Z');
  });

  it('is exactly twenty-four hours for a zone with no clock change', () => {
    const { from, to } = serviceDayBounds('2026-09-11', 'America/Barbados');
    expect(to.getTime() - from.getTime()).toBe(24 * 60 * 60 * 1000);
  });

  /**
   * A late-night shop's Friday includes what it sold at 1am on Saturday.
   * Without this the busiest two hours of a weekend land in the wrong
   * report.
   */
  it('honours a rollover hour, so the small hours belong to the night before', () => {
    const { from, to } = serviceDayBounds('2026-09-11', 'America/Barbados', { rolloverHour: 4 });
    expect(from.toISOString()).toBe('2026-09-11T08:00:00.000Z');
    expect(to.toISOString()).toBe('2026-09-12T08:00:00.000Z');
  });

  /**
   * Offsets change. A summary that is an hour wrong twice a year is a
   * summary somebody stops trusting, so the bounds are taken from the
   * runtime's own zone data rather than from arithmetic on one offset.
   */
  it('survives a daylight saving change', () => {
    // New York leaves daylight saving on 1 November 2026, so that local day
    // is twenty-five hours long.
    const { from, to } = serviceDayBounds('2026-11-01', 'America/New_York');
    expect(from.toISOString()).toBe('2026-11-01T04:00:00.000Z');
    expect(to.getTime() - from.getTime()).toBe(25 * 60 * 60 * 1000);
  });

  describe('which day we are in now', () => {
    it('reads the local date, not the UTC one', () => {
      // 02:00 UTC on the 12th is still the evening of the 11th in Barbados.
      expect(currentServiceDay('America/Barbados', new Date('2026-09-12T02:00:00Z'))).toBe('2026-09-11');
    });

    it('keeps the small hours in the previous service when a rollover is set', () => {
      // 05:30 UTC is 01:30 local - after midnight, before a 4am rollover,
      // so still Friday's service.
      expect(currentServiceDay('America/Barbados', new Date('2026-09-12T05:30:00Z'), 4)).toBe('2026-09-11');
      // 09:00 UTC is 05:00 local, past the rollover: a new service.
      expect(currentServiceDay('America/Barbados', new Date('2026-09-12T09:00:00Z'), 4)).toBe('2026-09-12');
    });

    /** Exactly midnight must not fall into yesterday through an off-by-one. */
    it('treats local midnight as the new day when there is no rollover', () => {
      expect(currentServiceDay('America/Barbados', new Date('2026-09-12T04:00:00Z'))).toBe('2026-09-12');
    });
  });

  it('refuses a date it cannot read rather than guessing one', () => {
    expect(() => serviceDayBounds('yesterday', 'America/Barbados')).toThrow();
  });
});
