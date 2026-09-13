/**
 * What counts as the same line on a till.
 *
 * The rule looks trivial and is not: "burger" and "burger, no onions" are
 * two different things to make, and if they share an identity then tapping
 * the second increments the first and the kitchen is handed a ticket for
 * food nobody ordered. The customer finds out, not the shop.
 */

export interface BasketModifier {
  name: string;
  action: 'add' | 'remove' | 'on_side';
}

/**
 * A stable identity for one basket line.
 *
 * Modifiers are sorted before encoding, so choosing cheese then bacon is the
 * same line as bacon then cheese - a cashier should not end up with two
 * rows for one burger because of the order they tapped in.
 *
 * JSON rather than a joined string, for the same reason the recommender's
 * pair keys are: item names contain spaces and punctuation, and every
 * separator-and-split scheme breaks on the first dish called "chicken roti".
 */
export function basketLineKey(itemId: string, modifiers: BasketModifier[]): string {
  const sorted = [...modifiers].sort(
    (left, right) => left.name.localeCompare(right.name) || left.action.localeCompare(right.action),
  );
  return JSON.stringify([itemId, sorted.map((modifier) => [modifier.name, modifier.action])]);
}
