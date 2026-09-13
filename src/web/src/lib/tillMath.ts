/**
 * The two sums a cashier does in their head, done properly.
 *
 * MIRRORS src/domain/food/tillMath.ts, which is the copy the server and the
 * tests use. Duplicated rather than imported because the browser's tsconfig
 * only includes its own src, the same reason identity.ts and piiDetector.ts
 * mirror their domain counterparts.
 *
 * Safe to mirror, unlike a price: nothing here decides what anything costs.
 * The total arrives from the server already priced, and these two functions
 * only answer "they handed me this, what do I hand back" - a question with
 * one arithmetic answer that cannot drift into disagreeing with the books.
 *
 * Counting change is the one piece of arithmetic in this whole system that
 * a customer watches happen and checks. Getting it wrong in the shop's
 * favour is theft as far as they are concerned, and getting it wrong the
 * other way is a slow leak nobody notices until the drawer is counted. So
 * it is integer cents, it is a pure function, and it is tested.
 *
 * Nothing here decides what anything costs. The total comes from the
 * server, which priced it against the catalogue; this only answers "they
 * handed me this, what do I hand back".
 */

export interface ChangeDue {
  /** What they handed over. */
  tenderedCents: number;
  /** What to hand back. Zero when they gave the exact amount. */
  changeCents: number;
  /** How much is still owed, when they have not given enough yet. */
  shortfallCents: number;
  /** True when the money on the counter covers the bill. */
  settled: boolean;
}

/**
 * What to hand back.
 *
 * Short payment is a real and ordinary state, not an error: somebody counts
 * out notes one at a time, and a till that refuses to show a running
 * shortfall makes them do the subtraction themselves. So this reports BOTH
 * directions and never goes negative in either - a negative change figure
 * on a screen is read as change, and somebody hands it over.
 */
export function changeDue(totalCents: number, tenderedCents: number): ChangeDue {
  const total = Math.max(0, Math.round(finite(totalCents)));
  const tendered = Math.max(0, Math.round(finite(tenderedCents)));

  return {
    tenderedCents: tendered,
    changeCents: Math.max(0, tendered - total),
    shortfallCents: Math.max(0, total - tendered),
    settled: tendered >= total,
  };
}

/**
 * The buttons worth offering beside the keypad.
 *
 * Not fixed denominations. A fixed row of 5/20/50/100 is wrong half the
 * time - on a $92 bill, three of those four buttons are useless and the one
 * that matters is missing. So the options are derived from the bill itself:
 * the exact amount first, because that is what most people hand over, then
 * the round numbers somebody would realistically produce from a wallet.
 *
 * The steps are the note sizes a person actually carries. Anything smaller
 * than the bill is left out - it cannot settle it, and a button that
 * shortchanges the till is a button somebody presses at speed by mistake.
 */
export function quickTenderOptions(totalCents: number, limit = 4): number[] {
  const total = Math.max(0, Math.round(finite(totalCents)));
  if (total === 0) return [];

  /* Note sizes, in cents. Chosen to match what circulates rather than a
     neat power series: nobody hands over a 1000 note. */
  const NOTES = [500, 1_000, 2_000, 5_000, 10_000, 20_000];

  const options = new Set<number>([total]);

  for (const note of NOTES) {
    // The next whole multiple of this note at or above the bill. For a
    // $23.50 bill and a $20 note that is $40 - two twenties - which is
    // exactly what somebody pulls out.
    const rounded = Math.ceil(total / note) * note;
    if (rounded >= total) options.add(rounded);
  }

  return [...options].sort((left, right) => left - right).slice(0, limit);
}

/**
 * Reads what somebody typed on the keypad.
 *
 * A till keypad takes digits and builds the amount from the right - typing
 * 1, 5, 0 means $1.50, not $150. That is how every till since the
 * mechanical ones has worked, and a cashier who has used one will type it
 * that way whatever this app would prefer.
 */
export function keypadDigitsToCents(digits: string): number {
  const onlyDigits = digits.replace(/\D+/g, '').slice(0, 9);
  if (!onlyDigits) return 0;
  return Number(onlyDigits);
}

/** NaN and Infinity arrive from parsed input often enough to be worth refusing once, here. */
function finite(value: number): number {
  return Number.isFinite(value) ? value : 0;
}
