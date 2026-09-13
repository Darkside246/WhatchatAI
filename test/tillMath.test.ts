import { describe, expect, it } from 'vitest';
import { changeDue, keypadDigitsToCents, quickTenderOptions } from '../src/domain/food/tillMath.js';

/**
 * Counting change.
 *
 * The one piece of arithmetic in this system a customer watches happen and
 * checks. Wrong in the shop's favour is theft as far as they are concerned;
 * wrong the other way is a leak nobody notices until the drawer is counted.
 */

describe('what to hand back', () => {
  it('counts the change', () => {
    expect(changeDue(2_500, 10_000).changeCents).toBe(7_500);
  });

  it('hands back nothing on the exact amount', () => {
    const due = changeDue(2_500, 2_500);
    expect(due.changeCents).toBe(0);
    expect(due.settled).toBe(true);
  });

  it('treats a short payment as an ordinary state, not an error', () => {
    // Somebody counting notes out one at a time. A till that refuses to
    // show a running shortfall makes them do the subtraction themselves.
    const due = changeDue(2_500, 2_000);
    expect(due.shortfallCents).toBe(500);
    expect(due.settled).toBe(false);
  });

  it('never reports a negative change figure', () => {
    // A negative number in the change box is read as change, and somebody
    // hands it over.
    expect(changeDue(2_500, 2_000).changeCents).toBe(0);
  });

  it('never reports a negative shortfall either', () => {
    expect(changeDue(2_500, 10_000).shortfallCents).toBe(0);
  });

  it('settles a free order without asking for anything', () => {
    expect(changeDue(0, 0).settled).toBe(true);
  });

  it('survives values that are not numbers', () => {
    const due = changeDue(Number.NaN, Number.POSITIVE_INFINITY);
    expect(due.changeCents).toBe(0);
    expect(due.tenderedCents).toBe(0);
  });

  it('refuses a negative tender rather than inventing change', () => {
    expect(changeDue(2_500, -10_000).shortfallCents).toBe(2_500);
  });
});

describe('the quick buttons beside the keypad', () => {
  it('offers the exact amount first, because that is what most people hand over', () => {
    expect(quickTenderOptions(2_500)[0]).toBe(2_500);
  });

  it('offers the notes somebody would actually pull out', () => {
    // $23.50: two twenties is $40, a fifty is $50. Both are real handfuls.
    const options = quickTenderOptions(2_350, 6);
    expect(options).toContain(2_350);
    expect(options).toContain(4_000);
    expect(options).toContain(5_000);
  });

  it('never offers less than the bill', () => {
    // A button that shortchanges the till is one somebody presses at speed
    // by mistake.
    for (const option of quickTenderOptions(9_200, 6)) expect(option).toBeGreaterThanOrEqual(9_200);
  });

  it('adapts to the bill rather than showing a fixed row', () => {
    // The failure a fixed 5/20/50/100 row has: on a $92 bill three of the
    // four buttons cannot settle it and the one that matters is missing.
    const small = quickTenderOptions(450, 6);
    const large = quickTenderOptions(9_200, 6);
    expect(small).not.toEqual(large);
    expect(large).toContain(10_000);
  });

  it('has nothing to offer on an empty bill', () => {
    expect(quickTenderOptions(0)).toEqual([]);
  });

  it('never repeats the same amount twice', () => {
    // A round bill rounds to itself under several notes at once.
    const options = quickTenderOptions(10_000, 6);
    expect(new Set(options).size).toBe(options.length);
  });
});

describe('typing on the keypad', () => {
  it('builds the amount from the right, like every till ever made', () => {
    // 1, 5, 0 is one dollar fifty. A cashier who has used a till will type
    // it that way whatever this app would prefer.
    expect(keypadDigitsToCents('150')).toBe(150);
    expect(keypadDigitsToCents('5')).toBe(5);
    expect(keypadDigitsToCents('10000')).toBe(10_000);
  });

  it('reads nothing as nothing', () => {
    expect(keypadDigitsToCents('')).toBe(0);
  });

  it('ignores anything that is not a digit', () => {
    expect(keypadDigitsToCents('1a2.3')).toBe(123);
  });

  it('refuses to build a number nobody could have meant', () => {
    // A stuck key should not produce a bill in the billions.
    expect(keypadDigitsToCents('1'.repeat(30))).toBe(111_111_111);
  });
});

describe('the copy the browser uses', () => {
  it('is character-for-character the same arithmetic as the server\'s', async () => {
    // tillMath is mirrored into src/web/src/lib because the browser's
    // tsconfig only includes its own src. A mirror that drifts is worse
    // than no mirror: the till would count change one way and the books
    // another. This fails the moment the two stop agreeing.
    const [domain, web] = await Promise.all([
      import('node:fs/promises').then((fs) => fs.readFile('src/domain/food/tillMath.ts', 'utf8')),
      import('node:fs/promises').then((fs) => fs.readFile('src/web/src/lib/tillMath.ts', 'utf8')),
    ]);

    // The browser copy carries an extra paragraph saying it IS a copy; the
    // code below the header has to be identical.
    const body = (source: string) => source.slice(source.indexOf('export interface ChangeDue'));
    expect(body(web)).toBe(body(domain));
  });
});
