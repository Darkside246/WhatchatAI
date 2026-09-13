import { describe, expect, it } from 'vitest';
import { EscPosBuilder, columnsFor, formatMoney, toPrinterBytes, wrap } from '../../src/web/src/lib/escpos.js';

const ESC = 0x1b;
const GS = 0x1d;
const LF = 0x0a;

/** What a fresh builder always emits: reset, then code page 437. */
const PREAMBLE = [ESC, 0x40, ESC, 0x74, 0x00];

function text(bytes: Uint8Array): string {
  return String.fromCharCode(...bytes);
}

describe('toPrinterBytes', () => {
  it('passes plain ASCII through one byte per character', () => {
    expect(toPrinterBytes('Fries')).toEqual([0x46, 0x72, 0x69, 0x65, 0x73]);
  });

  it('folds an accent to its base letter rather than emitting a byte the printer has no glyph for', () => {
    expect(String.fromCharCode(...toPrinterBytes('Crème brûlée'))).toBe('Creme brulee');
  });

  it('folds the punctuation a phone keyboard inserts', () => {
    expect(String.fromCharCode(...toPrinterBytes('“John’s” — no…'))).toBe('"John\'s" - no...');
  });

  it('substitutes a visible ? for anything still unmappable, never a random glyph', () => {
    expect(toPrinterBytes('rice 🍚')).toEqual([...toPrinterBytes('rice '), 0x3f]);
  });

  it('keeps a newline as a real line feed', () => {
    expect(toPrinterBytes('a\nb')).toEqual([0x61, LF, 0x62]);
  });
});

describe('wrap', () => {
  it('wraps on spaces at the column count', () => {
    expect(wrap('one two three four', 9)).toEqual(['one two', 'three', 'four']);
  });

  it('breaks a word longer than the paper instead of letting it run off the edge', () => {
    expect(wrap('abcdefghij', 4)).toEqual(['abcd', 'efgh', 'ij']);
  });

  it('keeps deliberate line breaks', () => {
    expect(wrap('a\nb', 20)).toEqual(['a', 'b']);
  });

  it('returns one empty line for empty input rather than nothing', () => {
    expect(wrap('', 20)).toEqual(['']);
  });
});

describe('formatMoney', () => {
  it('prints the currency code and two decimals, with no non-ASCII spacing', () => {
    expect(formatMoney(1050, 'BBD')).toBe('BBD 10.50');
    expect(formatMoney(0, 'USD')).toBe('USD 0.00');
  });

  it('keeps a refund negative rather than showing it as a charge', () => {
    expect(formatMoney(-500, 'BBD')).toBe('-BBD 5.00');
  });

  it('is entirely printable on code page 437', () => {
    const bytes = toPrinterBytes(formatMoney(123456, 'BBD'));
    expect(bytes).not.toContain(0x3f);
  });
});

describe('EscPosBuilder', () => {
  it('always resets and sets the code page first, so nothing inherits the last ticket', () => {
    expect([...new EscPosBuilder().build()]).toEqual(PREAMBLE);
  });

  it('sizes itself to the paper', () => {
    expect(columnsFor(58)).toBe(32);
    expect(columnsFor(80)).toBe(48);
    expect(new EscPosBuilder(80).columns).toBe(48);
  });

  it('pads a two-column line to exactly the paper width', () => {
    const built = new EscPosBuilder(58).columns2('Subtotal', 'BBD 10.50').build();
    const line = text(built.slice(PREAMBLE.length)).replace(/\n$/, '');
    expect(line).toHaveLength(32);
    expect(line.startsWith('Subtotal')).toBe(true);
    expect(line.endsWith('BBD 10.50')).toBe(true);
  });

  it('sacrifices the label, never the amount, when the two cannot both fit', () => {
    const built = new EscPosBuilder(58).columns2('A very long item name indeed here', 'BBD 1000.00').build();
    const line = text(built.slice(PREAMBLE.length)).replace(/\n$/, '');
    expect(line.endsWith('BBD 1000.00')).toBe(true);
    expect(line.length).toBeLessThanOrEqual(32);
  });

  it('emits the real bold and alignment codes', () => {
    const built = [...new EscPosBuilder().align('center').bold(true).build()];
    expect(built).toEqual([...PREAMBLE, ESC, 0x61, 1, ESC, 0x45, 1]);
  });

  it('feeds the paper clear of the head before cutting', () => {
    const built = [...new EscPosBuilder().cut().build()];
    expect(built).toEqual([...PREAMBLE, LF, LF, LF, LF, GS, 0x56, 66, 0]);
  });

  it('wraps a long line to the paper rather than losing the end of it', () => {
    const built = new EscPosBuilder(58).line('x'.repeat(40)).build();
    const lines = text(built.slice(PREAMBLE.length)).split('\n').filter(Boolean);
    expect(lines).toEqual(['x'.repeat(32), 'x'.repeat(8)]);
  });
});
