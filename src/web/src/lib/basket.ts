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
  /** How many of the extra. Absent means one. */
  quantity?: number | undefined;
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
  /* Quantity is part of the identity too, and for the same reason the
     modifier itself is: one pot of sauce and three pots are different
     money and a different thing to pack. Without it, adding a burger with
     one sauce and then a burger with three would increment the first line
     and the second customer would get one sauce. Normalised to a number so
     an absent quantity and an explicit 1 are the same line, which keeps
     every basket built before this existed intact. */
  return JSON.stringify([
    itemId,
    sorted.map((modifier) => [modifier.name, modifier.action, Math.max(1, Math.trunc(modifier.quantity ?? 1))]),
  ]);
}
