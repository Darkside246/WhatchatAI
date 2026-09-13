import { describe, expect, it } from 'vitest';
import { buildCustomerReceipt, buildKitchenTicket, type TicketBusiness } from '../../src/web/src/lib/foodTicket.js';
import type { FoodBoardOrderDto, FoodOrderLineDto } from '../../src/web/src/lib/api.js';

/**
 * Readable text out of the byte stream, so a test can assert what a person
 * would actually read off the paper.
 *
 * Walks the stream and skips each command by its own known length rather
 * than pattern-matching it. A regex here reads the next command's ESC as
 * this command's argument and silently corrupts the text after it - which
 * is exactly the kind of wrong that makes a test agree with a bug.
 */
function printed(ticket: { bytes: Uint8Array }): string {
  const bytes = ticket.bytes;
  const ESC = 0x1b;
  const GS = 0x1d;
  let out = '';
  let index = 0;
  while (index < bytes.length) {
    const byte = bytes[index]!;
    if (byte === ESC) {
      const command = bytes[index + 1];
      // ESC @ takes no argument; ESC t/a/E/p each take one (p takes three).
      index += command === 0x40 ? 2 : command === 0x70 ? 5 : 3;
      continue;
    }
    if (byte === GS) {
      const command = bytes[index + 1];
      // GS ! takes one argument; GS V takes two.
      index += command === 0x21 ? 3 : 4;
      continue;
    }
    out += String.fromCharCode(byte);
    index += 1;
  }
  return out;
}

function line(overrides: Partial<FoodOrderLineDto> = {}): FoodOrderLineDto {
  return {
    menuItemId: 'item-1', name: 'Fish cutter', variant: null, quantity: 2,
    unitPriceCents: 800, modifiers: [], notes: null, station: null, ...overrides,
  };
}

function order(overrides: Partial<FoodBoardOrderDto> = {}): FoodBoardOrderDto {
  return {
    id: 'order-1', orderNumber: 42, chatId: null, stage: 'IN_KITCHEN',
    fulfilmentMethod: 'PICKUP', customerName: 'Ama', customerPhone: null,
    items: [line()], subtotalCents: 1600, deliveryFeeCents: 0, totalCents: 1600, currency: 'BBD',
    deliveryAddress: null, deliveryNotes: null, allergenNotes: null, kitchenNotes: null,
    placedAt: '2026-09-13T12:00:00.000Z', elapsedSeconds: 60, slaBand: 'ON_TIME', nextStage: 'READY',
    paymentState: 'PAID', paymentWaiverReason: null, tableLabel: null, blockedReason: null,
    navigationUrl: null, qcFindings: [], qcCheckId: null, qcCheckedAt: null, qcAcknowledgedAt: null,
    qcPhotoOutstanding: false, delivery: null, paymentRequest: null,
    ...overrides,
  } as FoodBoardOrderDto;
}

const BUSINESS: TicketBusiness = {
  name: 'Island Grill', address: '12 Bay Street', phone: '+1 246 555 0100',
  taxRegistrationNumber: 'VAT-123', taxRegistrationLabel: 'VAT',
};

describe('the kitchen ticket', () => {
  it('leads with the order number, which is what everything else calls it', () => {
    const sheet = printed(buildKitchenTicket(order()));
    expect(sheet.split('\n')[0]).toBe('#42');
  });

  it('carries the food and never the prices - a cook has no use for them', () => {
    const sheet = printed(buildKitchenTicket(order()));
    expect(sheet).toContain('2 x Fish cutter');
    expect(sheet).not.toContain('BBD');
  });

  it('puts the allergy warning above the food, not below it', () => {
    const sheet = printed(buildKitchenTicket(order({ allergenNotes: 'Severe peanut allergy' })));
    expect(sheet.indexOf('ALLERGY')).toBeLessThan(sheet.indexOf('Fish cutter'));
    expect(sheet).toContain('Severe peanut allergy');
  });

  it('spells out each modifier so nothing depends on remembering a symbol', () => {
    const sheet = printed(
      buildKitchenTicket(
        order({
          items: [line({ modifiers: [
            { name: 'pepper sauce', action: 'remove', priceDeltaCents: 0 },
            { name: 'slaw', action: 'on_side', priceDeltaCents: 0 },
            { name: 'cheese', action: 'add', priceDeltaCents: 200 },
          ] })],
        }),
      ),
    );
    expect(sheet).toContain('NO pepper sauce');
    expect(sheet).toContain('SIDE slaw');
    expect(sheet).toContain('+ cheese');
  });

  it('says an unpaid ticket is unpaid, because paper outlives the screen', () => {
    expect(printed(buildKitchenTicket(order({ paymentState: 'UNPAID' })))).toContain('NOT PAID');
    expect(printed(buildKitchenTicket(order({ paymentState: 'PAID' })))).not.toContain('NOT PAID');
  });

  it('brackets another station’s lines rather than hiding them', () => {
    const sheet = printed(
      buildKitchenTicket(
        order({ items: [line({ name: 'Fries', station: 'fryer' }), line({ name: 'Salad', station: 'cold' })] }),
        { station: 'fryer' },
      ),
    );
    expect(sheet).toContain('2 x Fries');
    expect(sheet).toContain('(2 x Salad)');
  });

  it('prints the address only for a delivery', () => {
    const delivery = printed(buildKitchenTicket(order({ fulfilmentMethod: 'DELIVERY', deliveryAddress: '9 Hill Road' })));
    expect(delivery).toContain('DELIVER TO');
    expect(delivery).toContain('9 Hill Road');
    expect(printed(buildKitchenTicket(order({ deliveryAddress: '9 Hill Road' })))).not.toContain('DELIVER TO');
  });
});

describe('the customer receipt', () => {
  it('carries the business identity a receipt is required to show', () => {
    const sheet = printed(buildCustomerReceipt(order(), BUSINESS));
    expect(sheet).toContain('Island Grill');
    expect(sheet).toContain('12 Bay Street');
    expect(sheet).toContain('VAT: VAT-123');
  });

  it('prices each line by quantity, so the lines add up to the total', () => {
    const sheet = printed(buildCustomerReceipt(order(), BUSINESS));
    expect(sheet).toContain('BBD 16.00');
  });

  it('itemises a priced modifier rather than folding it into a line that then looks wrong', () => {
    const sheet = printed(
      buildCustomerReceipt(
        order({ items: [line({ quantity: 1, modifiers: [{ name: 'cheese', action: 'add', priceDeltaCents: 200 }] })] }),
        BUSINESS,
      ),
    );
    expect(sheet).toContain('+ cheese');
    expect(sheet).toContain('BBD 2.00');
  });

  it('prints no tax line at all when the business charges none', () => {
    expect(printed(buildCustomerReceipt(order(), BUSINESS))).not.toContain('Tax');
  });

  it('works tax out of the total rather than adding it on top', () => {
    // 1600 gross at 17.5% VAT-inclusive is 238 of tax, not 280.
    const sheet = printed(buildCustomerReceipt(order(), BUSINESS, { taxBasisPoints: 1750 }));
    expect(sheet).toContain('Tax (17.50%)');
    expect(sheet).toContain('BBD 2.38');
  });

  it('shows the delivery fee only when one was charged', () => {
    const sheet = printed(buildCustomerReceipt(order({ deliveryFeeCents: 500, totalCents: 2100 }), BUSINESS));
    expect(sheet).toContain('Delivery');
    expect(printed(buildCustomerReceipt(order(), BUSINESS))).not.toContain('Delivery');
  });

  it('states what happened with the money', () => {
    expect(printed(buildCustomerReceipt(order({ paymentState: 'PAID' }), BUSINESS))).toContain('PAID');
    expect(printed(buildCustomerReceipt(order({ paymentState: 'WAIVED' }), BUSINESS))).toContain('NO CHARGE');
    expect(printed(buildCustomerReceipt(order({ paymentState: 'REFUNDED' }), BUSINESS))).toContain('REFUNDED');
  });

  it('omits optional business details rather than printing an empty line for them', () => {
    const bare = printed(buildCustomerReceipt(order(), { name: 'Stall', address: null, phone: null, taxRegistrationNumber: null, taxRegistrationLabel: null }));
    expect(bare).toContain('Stall');
    expect(bare).not.toContain('null');
  });
});

/**
 * The two halves of a ticket must say the same thing.
 *
 * A kitchen with a Bluetooth printer at the pass and an iPad printing to
 * the office printer is printing the same order two ways, and a difference
 * between them is a difference nobody would ever think to look for.
 */
describe('the byte stream and the printable sheet', () => {
  it('carry the same lines for a kitchen ticket', () => {
    const ticket = buildKitchenTicket(
      order({ allergenNotes: 'No shellfish', kitchenNotes: 'Ring the bell', items: [line({ notes: 'extra hot' })] }),
    );
    // Trailing blanks trimmed from both: the bytes carry the feed that
    // clears the cutter, and the sheet deliberately does not.
    const trimTrailingBlanks = (rows: string[]) => {
      const copy = [...rows];
      while (copy.length > 0 && copy[copy.length - 1] === '') copy.pop();
      return copy;
    };
    expect(trimTrailingBlanks(ticket.text.split('\n'))).toEqual(trimTrailingBlanks(printed(ticket).split('\n')));
  });

  it('carry the same lines for a receipt, money column included', () => {
    const ticket = buildCustomerReceipt(order({ deliveryFeeCents: 500, totalCents: 2100 }), BUSINESS, { taxBasisPoints: 1750 });
    for (const row of ticket.text.split('\n')) expect(printed(ticket)).toContain(row);
    // The alignment itself, not just the words - this is the thing that
    // broke once already.
    const totalRow = ticket.text.split('\n').find((row) => row.startsWith('TOTAL'));
    expect(totalRow).toHaveLength(32);
    expect(totalRow?.endsWith('BBD 21.00')).toBe(true);
  });

  it('leaves no trailing blank strip on the printable sheet', () => {
    expect(buildKitchenTicket(order()).text.endsWith('\n')).toBe(false);
  });
});
