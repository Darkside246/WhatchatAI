import { describe, expect, it } from 'vitest';
import { judgePairingAttempt, MAX_UNSCANNED_PAIRING_CYCLES } from '../src/services/whatsappReconnectBackoff.js';

/**
 * Knowing when to stop offering a code nobody is scanning.
 *
 * An account with no session does this forever, roughly every thirty
 * seconds: connect, issue a QR, nobody scans it, the code expires, the
 * socket closes, back off, repeat. Two businesses sat in exactly that loop
 * in production for hours, on a two-gigabyte droplet, drowning every other
 * log line. The backoff was working perfectly and capping at thirty
 * seconds, which is the whole point - nothing ever decided to stop.
 *
 * The rule that must never break: this can only ever give up on an account
 * that is WAITING TO BE PAIRED. A paired account on a flaky network issues
 * no QR, so it never advances the count and reconnects forever exactly as
 * it always has.
 */

describe('an attempt that offered a code and was not scanned', () => {
  it('counts it', () => {
    expect(judgePairingAttempt(true, 0)).toEqual({ cycles: 1, stop: false });
  });

  it('keeps trying while there is still patience left', () => {
    for (let cycles = 0; cycles < MAX_UNSCANNED_PAIRING_CYCLES - 1; cycles += 1) {
      expect(judgePairingAttempt(true, cycles).stop).toBe(false);
    }
  });

  it('stops once the codes have gone unanswered enough times', () => {
    expect(judgePairingAttempt(true, MAX_UNSCANNED_PAIRING_CYCLES - 1)).toEqual({
      cycles: MAX_UNSCANNED_PAIRING_CYCLES,
      stop: true,
    });
  });

  it('stays stopped rather than resetting past the limit', () => {
    expect(judgePairingAttempt(true, MAX_UNSCANNED_PAIRING_CYCLES + 3).stop).toBe(true);
  });

  it('gives somebody several minutes to fetch their phone', () => {
    // Each cycle is a full Baileys QR window. Fewer than three would cut
    // off somebody who opened the pairing screen and walked to get their
    // phone, which is the ordinary way this is actually used.
    expect(MAX_UNSCANNED_PAIRING_CYCLES).toBeGreaterThanOrEqual(3);
  });
});

describe('an attempt that never offered a code', () => {
  it('never counts against the limit', () => {
    // The safety property. A paired account dropping on a flaky network
    // has credentials, so it issues no QR - and must keep reconnecting for
    // as long as it takes, however many times it fails.
    expect(judgePairingAttempt(false, 0)).toEqual({ cycles: 0, stop: false });
  });

  it('never stops, even after a great many failures', () => {
    expect(judgePairingAttempt(false, 500)).toEqual({ cycles: 500, stop: false });
  });

  it('does not reset a count that a real pairing run had built up', () => {
    // Leaving the count alone rather than zeroing it: only a successful
    // connection, or a person asking to connect, means anything has
    // changed. A single QR-less blip in the middle of an unscanned run is
    // not evidence that somebody has picked up their phone.
    expect(judgePairingAttempt(false, 3).cycles).toBe(3);
  });
});
