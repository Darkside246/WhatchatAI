// Exponential backoff (1s, 2s, 4s, 8s, 16s, capped at 30s) with +/-20%
// jitter. Extracted as a pure function so the backoff/jitter behaviour is
// directly testable without a live Baileys socket - see
// whatsappReconnectBackoff.test.ts.
//
// The jitter matters as much as the exponential curve itself: without it,
// every account whose socket drops around the same moment (a shared server
// restart, an ISP-wide blip) reconnects on the identical schedule - attempt
// 1 at exactly 1s for all of them, attempt 2 at exactly 2s for all of them -
// turning independent retries into a synchronized thundering herd against
// WhatsApp's own servers at the same instants.
export function reconnectDelayMs(attempt: number, random: () => number = Math.random): number {
  const baseDelay = Math.min(1_000 * 2 ** Math.min(attempt - 1, 5), 30_000);
  const jitter = baseDelay * 0.2 * (random() * 2 - 1);
  return Math.max(0, Math.round(baseDelay + jitter));
}

/**
 * How many pairing cycles nobody answers before the automatic loop stops.
 *
 * Each cycle is a full Baileys QR window - a code is issued, refreshed a
 * few times, and expires - so five of them is several minutes of offering a
 * code to an empty room. Long enough that somebody who opened the pairing
 * screen and went to find their phone is never cut off; short enough that
 * an account nobody is pairing stops costing anything within minutes
 * rather than running until the process is restarted.
 */
export const MAX_UNSCANNED_PAIRING_CYCLES = 5;

/**
 * Whether to keep offering pairing codes after a connection attempt failed.
 *
 * An account with no session does this forever, roughly every thirty
 * seconds: connect, issue a QR, nobody scans it, the code expires, the
 * socket closes, back off, repeat. Two businesses sat in exactly that loop
 * in production for hours. The backoff was working perfectly and capping at
 * thirty seconds, which is the point - nothing ever decided to stop.
 *
 * `sawQr` is what separates the two cases that reach this, and the
 * distinction is the whole safety argument. An attempt that issued a QR and
 * never opened means nobody is pairing this account. An attempt by an
 * already-paired account - a dropped connection on a flaky network - issues
 * no QR at all, so it never advances the count and keeps retrying forever,
 * exactly as it does today. Nothing that is working can be given up on by
 * this.
 *
 * Extracted as a pure function for the same reason reconnectDelayMs above
 * is: this decides whether a business's WhatsApp reconnects, and it has to
 * be checkable without a live socket.
 */
export function judgePairingAttempt(
  sawQr: boolean,
  cyclesSoFar: number,
  maxCycles: number = MAX_UNSCANNED_PAIRING_CYCLES,
): { cycles: number; stop: boolean } {
  if (!sawQr) return { cycles: cyclesSoFar, stop: false };

  const cycles = cyclesSoFar + 1;
  return { cycles, stop: cycles >= maxCycles };
}
