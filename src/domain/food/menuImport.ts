/**
 * Reading a menu somebody pasted in.
 *
 * A restaurant's menu already exists - in a Word document, a PDF, a
 * WhatsApp message to a designer, a photo of a board. What it is never in
 * is our data model, and a business asked to retype forty dishes into a
 * form will stop before it finishes and never come back. So this takes
 * the text they already have.
 *
 * The parser is deliberately forgiving about layout and deliberately
 * strict about money. A line it cannot price is not guessed at - it is
 * handed back as unparsed for a person to look at, because an item
 * imported at the wrong price is worse than one not imported at all.
 */

export interface ParsedMenuItem {
  category: string | null;
  name: string;
  priceCents: number;
  description: string | null;
  /** Which line of the pasted text it came from, so a preview can point at it. */
  line: number;
}

export interface UnparsedLine {
  line: number;
  text: string;
  reason: string;
}

export interface ParsedMenu {
  items: ParsedMenuItem[];
  /** Section headings in the order they appeared, which is the order the menu is read in. */
  categories: string[];
  unparsed: UnparsedLine[];
}

/**
 * A price at the end of a line.
 *
 * Anchored to the END on purpose: "2 for 1 Tuesdays 15.00" prices at 15,
 * not at 2. A leading currency symbol or code is allowed and discarded -
 * the menu's currency is the business's, not whatever somebody typed.
 */
const TRAILING_PRICE = /(?:^|[\s.\-–—:|,])(?:[$£€]|[A-Z]{3}\s?)?\s*(\d{1,6}(?:[.,]\d{1,2})?)\s*$/;

/** Leaders a printed menu uses between a name and its price: "Burger .......... 18.00". */
const LEADERS = /[\s.\-–—_:|]+$/;

/**
 * A description under an item, rather than an item with no price.
 *
 * Real menus put these on their own line, usually indented or in a
 * different case from a heading. Distinguishing them from a SECTION
 * heading is the one genuinely ambiguous judgement here, so it is made on
 * evidence rather than guessed: a heading is short, and a description is
 * a sentence.
 */
function looksLikeDescription(text: string): boolean {
  const words = text.split(/\s+/).filter(Boolean).length;
  // Six words or a comma is prose. "STARTERS" and "Sides & Salads" are not.
  return words > 5 || text.includes(',');
}

function parsePrice(raw: string): number | null {
  const amount = Number(raw.replace(',', '.'));
  if (!Number.isFinite(amount) || amount < 0) return null;
  // A menu in whole units ("Burger 18") and one in decimals ("18.00") mean
  // the same thing, and a restaurant writes both on the same page.
  return Math.round(amount * 100);
}

export function parseMenuText(text: string): ParsedMenu {
  const items: ParsedMenuItem[] = [];
  const categories: string[] = [];
  const unparsed: UnparsedLine[] = [];

  let category: string | null = null;

  text.split(/\r?\n/).forEach((raw, index) => {
    const line = index + 1;
    const trimmed = raw.trim();
    if (!trimmed) return;

    const match = TRAILING_PRICE.exec(trimmed);

    if (!match) {
      // No price. Either a section heading or the description of the item
      // above it.
      if (looksLikeDescription(trimmed) && items.length > 0) {
        const previous = items[items.length - 1]!;
        // Only attaches to an item from THIS section and the line
        // immediately above, so a stray sentence at the end of a menu does
        // not become the description of something unrelated.
        if (previous.line === line - 1 && previous.description === null) {
          previous.description = trimmed;
          return;
        }
        unparsed.push({ line, text: trimmed, reason: 'No price, and it does not read like a section heading.' });
        return;
      }

      category = trimmed.replace(/[:\-–—]+$/, '').trim();
      if (category && !categories.includes(category)) categories.push(category);
      return;
    }

    const priceCents = parsePrice(match[1]!);
    if (priceCents === null) {
      unparsed.push({ line, text: trimmed, reason: 'That price could not be read.' });
      return;
    }

    // The pattern starts at the separator BEFORE the price, so everything
    // to its left is the dish - leaders and all, which the trim below
    // removes. A line that is only a price matches at index 0 and leaves
    // nothing, which is exactly the case rejected next.
    const name = trimmed.slice(0, match.index).replace(LEADERS, '').trim();

    if (!name) {
      // A bare number on its own line - a page number, a total, a year.
      unparsed.push({ line, text: trimmed, reason: 'There is a price here but nothing to call it.' });
      return;
    }

    items.push({ category, name, priceCents, description: null, line });
  });

  return { items, categories, unparsed };
}
