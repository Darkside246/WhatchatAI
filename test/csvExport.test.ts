import { describe, expect, it } from 'vitest';
import { toCsv, toCsvRow } from '../src/services/export/csvExport.js';

describe('toCsvRow', () => {
  it('joins plain values with commas', () => {
    expect(toCsvRow(['a', 'b', 1, true])).toBe('a,b,1,true');
  });

  it('quotes a value containing a comma', () => {
    expect(toCsvRow(['Smith, John'])).toBe('"Smith, John"');
  });

  it('quotes and escapes a value containing a double quote', () => {
    expect(toCsvRow(['She said "hi"'])).toBe('"She said ""hi"""');
  });

  it('quotes a value containing a newline', () => {
    expect(toCsvRow(['line1\nline2'])).toBe('"line1\nline2"');
  });

  it('renders null and undefined as empty fields, never the literal string "null"', () => {
    expect(toCsvRow([null, undefined, 'x'])).toBe(',,x');
  });

  it('serializes an object/array value as JSON rather than "[object Object]"', () => {
    expect(toCsvRow([['a', 'b']])).toBe('"[""a"",""b""]"');
  });
});

describe('toCsv', () => {
  it('renders a real header row from column definitions, in the given order - not object key order', () => {
    const rows = [{ b: 2, a: 1 }];
    const csv = toCsv(rows, [{ key: 'a', header: 'A' }, { key: 'b', header: 'B' }]);
    expect(csv).toBe('A,B\r\n1,2');
  });

  it('renders one row per input record', () => {
    const rows = [{ name: 'Alice' }, { name: 'Bob' }];
    const csv = toCsv(rows, [{ key: 'name', header: 'Name' }]);
    expect(csv).toBe('Name\r\nAlice\r\nBob');
  });

  it('renders just the header row for an empty dataset - never a fabricated placeholder row', () => {
    const csv = toCsv([], [{ key: 'name', header: 'Name' }]);
    expect(csv).toBe('Name');
  });
});
