/**
 * Turning a ticket into bytes a thermal printer understands.
 *
 * ESC/POS is the command language almost every counter-top receipt printer
 * speaks - Epson's, and the very large number of inexpensive ones that copy
 * it. It is a byte stream, not a document: text with one-byte control
 * sequences threaded through it saying "bold on", "centre", "cut".
 *
 * Nothing here talks to a device. It builds a Uint8Array, and something
 * else carries it - Bluetooth, USB, or a file. Keeping it that way is what
 * makes a printer this codebase has never seen testable: the bytes are the
 * whole contract, and they can be asserted exactly.
 *
 * Deliberately limited to the commands that every clone implements. A
 * printer that ignores an unknown command prints garbage on a real ticket
 * in a real kitchen, so this uses the small set that has been common since
 * the 1990s rather than anything a particular vendor added.
 */

const ESC = 0x1b;
const GS = 0x1d;
const LF = 0x0a;

/** Characters per line. 58mm paper fits 32 at the default font, 80mm fits 48. */
export type PaperWidth = 58 | 80;

export function columnsFor(paper: PaperWidth): number {
  return paper === 58 ? 32 : 48;
}

/**
 * A printer speaks one byte per character, not UTF-8.
 *
 * Code page 437 is the near-universal default. Anything outside it - a
 * customer named with an accent, a curly quote pasted from a phone - has no
 * byte to be, and printers respond to an unmapped byte by printing a random
 * glyph. So the text is folded to the nearest plain ASCII first and
 * anything still unmappable becomes '?', which is legible and obviously a
 * substitution, rather than a character nobody can read.
 */
export function toPrinterBytes(text: string): number[] {
  const folded = text
    // Decompose, then drop the combining marks: "é" becomes "e".
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    // The punctuation phones insert, which is not in code page 437.
    .replace(/[\u2018\u2019\u201b]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\u2026/g, '...');

  const bytes: number[] = [];
  for (const char of folded) {
    const code = char.codePointAt(0) ?? 63;
    bytes.push(code >= 0x20 && code <= 0x7e ? code : code === 0x0a ? LF : 0x3f);
  }
  return bytes;
}

/**
 * Builds one ticket's bytes.
 *
 * A builder rather than a template because a ticket is assembled from parts
 * that each know their own formatting, and because the alternative - string
 * concatenation with escape codes inline - produces something no one can
 * read or test a line of.
 */
export class EscPosBuilder {
  private readonly bytes: number[] = [];
  /**
   * The same ticket as plain text, accumulated alongside the bytes.
   *
   * The browser-print fallback needs the identical document without the
   * control codes, and the one thing that must never happen is the two
   * drifting apart - a receipt that says something different depending on
   * which printer it came out of. Building both from the same calls makes
   * that impossible by construction, rather than by remembering to update a
   * second renderer.
   *
   * Alignment is not reproduced: the sheet is monospace at a fixed column
   * count, so left-aligned is what the paper looks like, and a centred line
   * is centred by the spaces the caller already has room for.
   */
  private readonly plain: string[] = [];
  readonly columns: number;

  constructor(private readonly paper: PaperWidth = 58) {
    this.columns = columnsFor(paper);
    // Reset. A printer keeps its last job's bold/size settings, so a ticket
    // that does not start from a known state inherits whatever the previous
    // one left behind.
    this.raw(ESC, 0x40);
    // Code page 437, matching toPrinterBytes above.
    this.raw(ESC, 0x74, 0x00);
  }

  private raw(...values: number[]): this {
    this.bytes.push(...values);
    return this;
  }

  align(where: 'left' | 'center' | 'right'): this {
    return this.raw(ESC, 0x61, where === 'left' ? 0 : where === 'center' ? 1 : 2);
  }

  bold(on: boolean): this {
    return this.raw(ESC, 0x45, on ? 1 : 0);
  }

  /**
   * Double width and height, for the one thing on the ticket that has to be
   * readable from across a kitchen - the order number.
   */
  big(on: boolean): this {
    return this.raw(GS, 0x21, on ? 0x11 : 0x00);
  }

  /**
   * One line, exactly as given.
   *
   * No wrapping and no whitespace handling of any kind: this is for text
   * that has already been laid out to the paper width, where a "helpful"
   * adjustment would undo the layout.
   */
  private exactLine(text: string): this {
    this.bytes.push(...toPrinterBytes(text), LF);
    this.plain.push(text);
    return this;
  }

  /** One line, wrapped to the paper rather than truncated - a dish whose name runs long is still a dish somebody has to make. */
  line(text = ''): this {
    if (text === '') {
      this.bytes.push(LF);
      this.plain.push('');
      return this;
    }
    for (const wrapped of wrap(text, this.columns)) {
      this.bytes.push(...toPrinterBytes(wrapped), LF);
      this.plain.push(wrapped);
    }
    return this;
  }

  /**
   * Left text and right text on one line, with the gap between them.
   *
   * The money column on a receipt. When the two cannot fit, the left side
   * gives way - a price that has been silently cut off is worse than a name
   * that has been.
   */
  columns2(left: string, right: string): this {
    const room = Math.max(0, this.columns - right.length - 1);
    const trimmedLeft = left.length > room ? left.slice(0, room) : left;
    const gap = Math.max(1, this.columns - trimmedLeft.length - right.length);
    /**
     * Written exactly, never through line().
     *
     * line() wraps, and wrapping splits on whitespace and rejoins with a
     * single space - which would collapse the gap this just computed and
     * turn every priced line on a receipt into "Fries BBD 10.50" jammed
     * against the left margin, with no money column at all.
     */
    return this.exactLine(`${trimmedLeft}${' '.repeat(gap)}${right}`);
  }

  rule(char = '-'): this {
    return this.exactLine(char.repeat(this.columns));
  }

  feed(lines = 1): this {
    for (let index = 0; index < lines; index += 1) {
      this.bytes.push(LF);
      this.plain.push('');
    }
    return this;
  }

  /**
   * Feed the paper clear of the head, then cut.
   *
   * The feed is not decoration: the cutter sits some way past the print
   * head, so cutting without it slices through the last few lines of the
   * ticket. GS V 66 is a partial cut, which leaves a small tab holding the
   * ticket on - it tears off cleanly and does not drop on the floor.
   */
  cut(): this {
    return this.feed(4).raw(GS, 0x56, 66, 0);
  }

  /** Opens a cash drawer wired to the printer's kick port, where one is. */
  openDrawer(): this {
    return this.raw(ESC, 0x70, 0x00, 0x19, 0xfa);
  }

  build(): Uint8Array {
    return new Uint8Array(this.bytes);
  }

  /**
   * The same document for the OS print dialog.
   *
   * The trailing feed the cutter needs is dropped - paper does not need
   * clearing on a sheet, and four blank lines at the end of every ticket
   * would waste a strip of every roll printed this way.
   */
  toPlainText(): string {
    const lines = [...this.plain];
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    return lines.join('\n');
  }
}

/**
 * Wraps on spaces, and breaks a word that is longer than the paper.
 *
 * A printer does not wrap: it prints past the edge and loses what does not
 * fit. So this has to be exact, and it has to handle the word that cannot
 * fit at all rather than emitting a line that will be cut off.
 */
export function wrap(text: string, columns: number): string[] {
  if (columns <= 0) return [text];
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    let current = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      if (word.length > columns) {
        if (current) {
          lines.push(current);
          current = '';
        }
        for (let index = 0; index < word.length; index += columns) {
          const piece = word.slice(index, index + columns);
          if (piece.length === columns) lines.push(piece);
          else current = piece;
        }
        continue;
      }
      if (!current) current = word;
      else if (current.length + 1 + word.length <= columns) current += ` ${word}`;
      else {
        lines.push(current);
        current = word;
      }
    }
    lines.push(current);
  }
  return lines;
}

export function formatMoney(cents: number, currency: string): string {
  // Deliberately not Intl.NumberFormat: it emits a non-breaking space and,
  // for some currencies, a symbol with no code page 437 byte - both of
  // which reach the printer as noise. The code plus the number is
  // unambiguous on a receipt and always printable.
  const sign = cents < 0 ? '-' : '';
  const absolute = Math.abs(cents);
  return `${sign}${currency} ${(absolute / 100).toFixed(2)}`;
}
