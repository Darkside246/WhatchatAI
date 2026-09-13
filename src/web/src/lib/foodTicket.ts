import { EscPosBuilder, formatMoney, type PaperWidth } from './escpos.js';
import type { FoodBoardOrderDto, FoodOrderLineDto } from './api.js';

/**
 * What actually comes out of the printer.
 *
 * Two different documents, deliberately not one with a flag:
 *
 * A KITCHEN ticket is read at arm's length by somebody with their hands
 * full. It carries what to make and nothing else - no prices, because a
 * cook does not need them and every line of noise is a line that pushes the
 * allergen warning further down the paper.
 *
 * A CUSTOMER receipt is the record of a transaction. It carries the money,
 * the business's own details, and the tax line, because that is what a
 * receipt is for.
 *
 * Both are built from the order the board already has. Nothing here invents
 * a figure: every number printed is one the server sent.
 */

/**
 * One ticket, in both forms.
 *
 * `bytes` goes to a Bluetooth or USB printer; `text` goes to the OS print
 * dialog for everyone whose browser has neither - an iPad, or a printer
 * installed as a normal system printer. They come from the same builder,
 * so they are the same document by construction.
 */
export interface Ticket {
  bytes: Uint8Array;
  text: string;
  paperMm: PaperWidth;
}

export interface TicketBusiness {
  name: string;
  address: string | null;
  phone: string | null;
  taxRegistrationNumber: string | null;
  taxRegistrationLabel: string | null;
}

function describeLine(line: FoodOrderLineDto): string[] {
  const rows: string[] = [];
  const head = line.variant ? `${line.name} (${line.variant})` : line.name;
  rows.push(`${line.quantity} x ${head}`);
  for (const modifier of line.modifiers) {
    const prefix = modifier.action === 'remove' ? 'NO' : modifier.action === 'on_side' ? 'SIDE' : '+';
    rows.push(`   ${prefix} ${modifier.name}`);
  }
  if (line.notes) rows.push(`   * ${line.notes}`);
  return rows;
}

const FULFILMENT_WORD: Record<FoodBoardOrderDto['fulfilmentMethod'], string> = {
  PICKUP: 'COLLECTION',
  DELIVERY: 'DELIVERY',
  DINE_IN: 'DINE IN',
};

/**
 * The kitchen's copy.
 *
 * Order number first and twice the size: on a rail of tickets it is the
 * only thing anybody reads from a distance, and it is what the board, the
 * customer and the driver all say.
 */
export function buildKitchenTicket(
  order: FoodBoardOrderDto,
  options: { paper?: PaperWidth; station?: string | null; printedAt?: Date } = {},
): Ticket {
  const paper = options.paper ?? 58;
  const builder = new EscPosBuilder(paper);
  const printedAt = options.printedAt ?? new Date();

  builder.align('center').bold(true).big(true).line(`#${order.orderNumber}`).big(false);
  builder.line(FULFILMENT_WORD[order.fulfilmentMethod]);
  if (order.tableLabel) builder.line(order.tableLabel);
  builder.bold(false).align('left').rule();

  builder.columns2(
    printedAt.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }),
    // Which station's copy this is, where a kitchen splits its printing.
    options.station ? options.station.toUpperCase() : 'ALL',
  );
  if (order.customerName) builder.line(order.customerName);
  builder.rule();

  /**
   * The allergen note goes ABOVE the food, not below it.
   *
   * It is the one thing on this ticket that can hurt somebody, and a ticket
   * long enough to need a second glance is a ticket where the bottom gets
   * missed.
   */
  if (order.allergenNotes) {
    builder.bold(true).line('** ALLERGY **').line(order.allergenNotes).bold(false).rule();
  }

  for (const line of order.items) {
    // Another station's work, on a ticket this one is also on. Marked
    // rather than removed: a cook should see the whole order, and a hidden
    // line is a line somebody assumes is handled.
    const mine = !options.station || !line.station || line.station === options.station;
    for (const row of describeLine(line)) builder.line(mine ? row : `(${row})`);
  }

  if (order.kitchenNotes) builder.rule().line(order.kitchenNotes);

  if (order.fulfilmentMethod === 'DELIVERY' && order.deliveryAddress) {
    builder.rule().bold(true).line('DELIVER TO').bold(false).line(order.deliveryAddress);
    if (order.deliveryNotes) builder.line(order.deliveryNotes);
  }

  // Said on the kitchen copy because an unpaid ticket reaching the pass is
  // the mistake the board exists to prevent, and paper outlives a screen.
  if (order.paymentState === 'UNPAID' || order.paymentState === 'AWAITING_VERIFICATION') {
    builder.rule().align('center').bold(true).line('NOT PAID').bold(false).align('left');
  }

  builder.cut();
  return { bytes: builder.build(), text: builder.toPlainText(), paperMm: paper };
}

/** The customer's copy - the money, and who took it. */
export function buildCustomerReceipt(
  order: FoodBoardOrderDto,
  business: TicketBusiness,
  options: { paper?: PaperWidth; printedAt?: Date; taxBasisPoints?: number } = {},
): Ticket {
  const paper = options.paper ?? 58;
  const builder = new EscPosBuilder(paper);
  const printedAt = options.printedAt ?? new Date();

  builder.align('center').bold(true).line(business.name).bold(false);
  if (business.address) builder.line(business.address);
  if (business.phone) builder.line(business.phone);
  if (business.taxRegistrationNumber) {
    builder.line(`${business.taxRegistrationLabel ?? 'Tax reg'}: ${business.taxRegistrationNumber}`);
  }
  builder.align('left').rule();

  builder.columns2(`#${order.orderNumber}`, printedAt.toLocaleDateString());
  builder.columns2(FULFILMENT_WORD[order.fulfilmentMethod], printedAt.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }));
  builder.rule();

  for (const line of order.items) {
    const head = line.variant ? `${line.name} (${line.variant})` : line.name;
    const modifierCents = line.modifiers.reduce((total, modifier) => total + modifier.priceDeltaCents, 0);
    const lineCents = (line.unitPriceCents + modifierCents) * line.quantity;
    builder.columns2(`${line.quantity} x ${head}`, formatMoney(lineCents, order.currency));
    // Priced modifiers are itemised: a receipt whose lines do not add up to
    // its own total is a receipt somebody queries at the counter.
    for (const modifier of line.modifiers) {
      if (modifier.priceDeltaCents === 0) continue;
      builder.columns2(`  + ${modifier.name}`, formatMoney(modifier.priceDeltaCents * line.quantity, order.currency));
    }
  }

  builder.rule();
  builder.columns2('Subtotal', formatMoney(order.subtotalCents, order.currency));
  if (order.deliveryFeeCents > 0) builder.columns2('Delivery', formatMoney(order.deliveryFeeCents, order.currency));
  /**
   * Printed only where a rate is actually configured, and worked out from
   * the total rather than guessed. A receipt claiming a tax line the
   * business does not charge is a document somebody could be held to.
   */
  if (options.taxBasisPoints && options.taxBasisPoints > 0) {
    const rate = options.taxBasisPoints / 10000;
    const taxCents = Math.round((order.totalCents * rate) / (1 + rate));
    builder.columns2(`Tax (${(rate * 100).toFixed(2)}%)`, formatMoney(taxCents, order.currency));
  }
  builder.bold(true).columns2('TOTAL', formatMoney(order.totalCents, order.currency)).bold(false);

  builder.rule();
  builder.line(
    order.paymentState === 'PAID'
      ? 'PAID'
      : order.paymentState === 'WAIVED'
        ? 'NO CHARGE'
        : order.paymentState === 'REFUNDED'
          ? 'REFUNDED'
          : order.paymentState === 'NOT_REQUIRED'
            ? ''
            : 'UNPAID',
  );

  builder.feed(1).align('center').line('Thank you').align('left');
  builder.cut();
  return { bytes: builder.build(), text: builder.toPlainText(), paperMm: paper };
}
