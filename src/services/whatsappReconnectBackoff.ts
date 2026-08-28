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
