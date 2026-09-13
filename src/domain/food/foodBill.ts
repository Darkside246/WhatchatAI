/**
 * The bill, written out for the customer to read on WhatsApp.
 *
 * A person who has ordered over chat has no receipt, no screen and no
 * counter to look at. All they have is the conversation - so the bill has
 * to BE a message: itemised, in their currency, with the total last and the
 * way to pay underneath it.
 *
 * WHAT THIS IS NOT. It is not a demand and it is not a confirmation of
 * payment. It says what the order came to and how to settle it, and nothing
 * in it may claim money has arrived - that claim belongs to the payment
 * record and to nothing else. A message that says "paid" because somebody
 * pressed send is how a business gives away an order's worth of food.
 *
 * Pure, and built from an order plus the business's own payment details -
 * no database, no network, no model. The wording is the business's where
 * the business has written any, and plain where it has not; nothing here
 * improvises a commercial term.
 */

export interface BillLine {
  name: string;
  quantity: number;
  /** What one of them costs, before modifiers. */
  unitPriceCents: number;
  /** What the modifiers add to ONE of them, already priced against the free allowance. */
  modifiersPerUnitCents: number;
  /** The changes themselves, so a customer can check what they asked for. */
  modifiers: { name: string; action: 'add' | 'remove' | 'on_side'; quantity?: number | undefined }[];
}

export interface BillInput {
  orderNumber: number;
  lines: BillLine[];
  subtotalCents: number;
  discountCents: number;
  deliveryFeeCents: number;
  taxCents: number;
  totalCents: number;
  currency: string;
  /** True when the prices already contain the tax - changes the wording, not the number. */
  taxInclusive: boolean;
  /**
   * How to pay, in the business's own words. Null when they have set none,
   * and then the bill simply does not say - it never invents a method.
   */
  payTo: string | null;
  /** Whether the kitchen waits for the money. Decides the closing line and nothing else. */
  paymentRequired: boolean;
}

function money(cents: number, currency: string): string {
  return `${currency} ${(cents / 100).toFixed(2)}`;
}

/** "2 x Fish cutter" reads better than "Fish cutter x2" to somebody scanning a phone. */
function describeLine(line: BillLine, currency: string): string {
  const each = line.unitPriceCents + line.modifiersPerUnitCents;
  const head = `${line.quantity} x ${line.name}  ${money(each * line.quantity, currency)}`;

  // Only the changes the customer asked for, in their words. A removal is
  // worth showing precisely because it is the thing most often got wrong.
  const changes = line.modifiers.map((modifier) => {
    const count = Math.max(1, Math.trunc(modifier.quantity ?? 1));
    const many = count > 1 ? `${count} x ` : '';
    if (modifier.action === 'remove') return `no ${modifier.name}`;
    if (modifier.action === 'on_side') return `${many}${modifier.name} on the side`;
    return `${many}${modifier.name}`;
  });

  return changes.length > 0 ? `${head}\n   (${changes.join(', ')})` : head;
}

/**
 * Builds the message.
 *
 * Every line that could be zero is omitted rather than printed as 0.00: a
 * bill with "Discount 0.00" on it invites the question "why is there a
 * discount line", and a tax line on a business that charges no tax is a
 * claim about their registration that is not ours to make.
 */
export function buildCustomerBill(input: BillInput): string {
  const lines: string[] = [`*Order #${input.orderNumber}*`, ''];

  for (const line of input.lines) lines.push(describeLine(line, input.currency));
  lines.push('');

  // The subtotal is only worth a line when something comes after it.
  const hasAdjustments = input.discountCents > 0 || input.deliveryFeeCents > 0 || (input.taxCents > 0 && !input.taxInclusive);
  if (hasAdjustments) lines.push(`Subtotal  ${money(input.subtotalCents, input.currency)}`);

  if (input.discountCents > 0) lines.push(`Discount  -${money(input.discountCents, input.currency)}`);
  if (input.deliveryFeeCents > 0) lines.push(`Delivery  ${money(input.deliveryFeeCents, input.currency)}`);

  if (input.taxCents > 0) {
    /* Worded by which kind it is, because the two mean opposite things to
       somebody adding up the column: an inclusive tax is already in the
       total above and an exclusive one is added to it. Getting this
       backwards makes the arithmetic on the page look wrong. */
    lines.push(
      input.taxInclusive
        ? `(includes ${money(input.taxCents, input.currency)} tax)`
        : `Tax  ${money(input.taxCents, input.currency)}`,
    );
  }

  lines.push(`*Total  ${money(input.totalCents, input.currency)}*`);

  if (input.payTo) {
    lines.push('', input.payTo.trim());
  }

  /* The closing line says what happens next, and says it honestly. Where
     the kitchen waits for money, the customer needs to know that is why
     nothing is happening yet. Where it does not, promising that payment
     starts anything would be a lie. */
  lines.push(
    '',
    input.paymentRequired
      ? 'We start on it as soon as the payment comes through.'
      : 'Thanks — anything else, just say.',
  );

  return lines.join('\n');
}
