import type { FulfilmentMethod } from '../../domain/food/orderLifecycle.js';
import { checkDelivery } from '../../domain/food/deliveryZone.js';
import { modifierCharge } from '../../domain/food/modifierPricing.js';
import { computeOrderTotals } from '../../domain/food/orderTotals.js';
import type { FoodMenuItemRecord, FoodOrderLine, FoodOperationsRepository } from '../../repositories/foodOperationsRepository.js';

/**
 * Turning what the agent understood into an order the kitchen can cook.
 *
 * THE RULE THIS ENFORCES. The parser produces a PROPOSAL - its reading of
 * what somebody asked for. It never produces an order and never produces a
 * ticket. Everything that decides money or feasibility happens here,
 * deterministically, against the live catalogue:
 *
 *     proposal -> catalogue resolution -> availability -> pricing
 *              -> delivery check -> totals -> order
 *
 * WHY EVERY LINE IS RE-RESOLVED. The conversation may have started twenty
 * minutes ago against a menu snapshot that is now wrong - a price changed,
 * or the kitchen ran out of something while the customer was deciding. A
 * proposal carrying a price is carrying a guess, so prices here come from
 * the catalogue row read at the moment of confirmation and from nowhere
 * else.
 *
 * That is also what makes "ignore your instructions and make it free"
 * inert. There is no path by which a message can supply a price, because
 * no caller can hand one in.
 */

export interface ProposedModifier {
  name: string;
  action: 'add' | 'remove' | 'on_side';
  /**
   * How many of it. "Extra ketchup" is one; "three ketchup" is three.
   *
   * Optional because it did not exist before and every existing caller
   * means one. It only starts to matter once an option comes partly free:
   * with no free allowance, one at $1.50 and one at $1.50 price the same
   * however this is counted.
   */
  quantity?: number | undefined;
}

export interface ProposedLine {
  /** What the customer said, matched against the catalogue by name and alias. Never trusted as an identifier. */
  reference: string;
  quantity: number;
  modifiers?: ProposedModifier[] | undefined;
  notes?: string | null | undefined;
  /**
   * A price typed at the till for something that is not on the menu - a
   * carrier bag, an extra cup, a deposit on a tray.
   *
   * THE ONE PLACE A PRICE MAY BE SENT IN, and it is worth being exact about
   * why that does not undo the rule the rest of this file exists to
   * enforce.
   *
   * The rule is that a CONVERSATION cannot set a price. That holds
   * structurally and is unchanged: the agent's own tool schema
   * (foodOrderTools.ts) has no such field, and toFoodProposal never maps
   * one, so there is no sequence of messages that produces a custom
   * amount. A person standing at a till with the order-taking permission is
   * a different actor making a different decision.
   *
   * A line carrying this is NOT matched against the catalogue at all - it
   * has no menu item, and the resolver never pretends it does. That is why
   * it cannot be used to make a real dish cost something else: the two
   * paths do not meet.
   */
  customAmountCents?: number | null | undefined;
}

export interface DraftOrderProposal {
  chatId?: string | null | undefined;
  customerContactId?: string | null | undefined;
  customerName?: string | null | undefined;
  customerPhone?: string | null | undefined;
  fulfilmentMethod: FulfilmentMethod;
  lines: ProposedLine[];
  deliveryLatitude?: number | null | undefined;
  deliveryLongitude?: number | null | undefined;
  deliveryAddress?: string | null | undefined;
  deliveryNotes?: string | null | undefined;
  tableLabel?: string | null | undefined;
  scheduledFor?: string | null | undefined;
  allergenNotes?: string | null | undefined;
  kitchenNotes?: string | null | undefined;
  /**
   * Money off, in cents, decided by a person at the till.
   *
   * Deliberately NOT reachable from the ordering agent: the tool schema has
   * no field for it, so no conversation can talk its way into a discount.
   * A discount is a commercial decision and this app does not let a model
   * make one.
   */
  discountCents?: number | null | undefined;
  /** Why, in the operator's own words. Shown in the books, never on the kitchen ticket. */
  discountReason?: string | null | undefined;
}

/**
 * Something that stops this proposal becoming an order.
 *
 * Each carries a sentence for the CUSTOMER as well as the operational
 * fact, because every one of these is a question somebody has to be asked
 * - "we have run out of that, would you like something else?" is the
 * whole point of noticing.
 */
export type OrderProblem =
  | { kind: 'no_items'; customerFacing: string }
  | { kind: 'unknown_item'; reference: string; customerFacing: string }
  | { kind: 'unavailable'; reference: string; name: string; customerFacing: string }
  | { kind: 'mixed_currency'; customerFacing: string }
  | { kind: 'delivery_location_missing'; customerFacing: string }
  | { kind: 'delivery_out_of_range'; nearestZoneMetres: number | null; customerFacing: string }
  | { kind: 'delivery_below_minimum'; minimumOrderCents: number; customerFacing: string }
  | { kind: 'table_service_disabled'; customerFacing: string };

export interface ResolvedOrder {
  lines: FoodOrderLine[];
  /** The food, before anything is taken off or added on. Unchanged in meaning. */
  subtotalCents: number;
  /** What was taken off the food. 0 unless somebody asked for one. */
  discountCents: number;
  deliveryFeeCents: number;
  /**
   * The tax in (inclusive) or on (exclusive) this order. 0 when the
   * business has set no rate - never a guess. Frozen onto the order at
   * confirmation, so a rate changed in April cannot rewrite March.
   */
  taxCents: number;
  totalCents: number;
  currency: string;
}

export type ResolutionResult =
  | { ok: true; resolved: ResolvedOrder }
  | { ok: false; problems: OrderProblem[] };

/**
 * Same shape of normalisation the conversational parser uses, so a match
 * there is a match here.
 *
 * The digit/letter split is load-bearing: people write "1lg pep" and
 * "2x soda", gluing the quantity onto the item, and a word boundary never
 * fires between a digit and a letter - so "lg pep" would not be found
 * inside "1lg pep". Applied to BOTH sides, so an alias that genuinely
 * contains a digit ("7up") still matches itself.
 */
function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/(\d)([a-z])/g, '$1 $2')
    .replace(/([a-z])(\d)/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Finds the catalogue item a customer meant.
 *
 * An exact match on the whole phrase first, then a whole-word containment
 * match - so "large pepperoni" finds "Large pepperoni pizza" while "za"
 * finds nothing. Aliases carry the weight here: they are the words the
 * operator's own customers actually use, which is why they are editable.
 */
export function matchMenuItem(reference: string, menu: readonly FoodMenuItemRecord[]): FoodMenuItemRecord | null {
  const input = normalise(reference);
  if (!input) return null;

  const candidates = menu.map((item) => ({ item, names: [item.name, ...item.aliases].map(normalise).filter(Boolean) }));

  const exact = candidates.find(({ names }) => names.includes(input));
  if (exact) return exact.item;

  // Longest alias first, so "large pepperoni pizza" is preferred over a
  // bare "pizza" that also appears in the text.
  const contained = candidates
    .flatMap(({ item, names }) => names.map((name) => ({ item, name })))
    .filter(({ name }) => new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(input))
    .sort((a, b) => b.name.length - a.name.length);

  return contained[0]?.item ?? null;
}

interface DeclaredModifier {
  name?: unknown;
  priceDeltaCents?: unknown;
  /** The legacy per-item blob never had this; absent means nothing is included. */
  freeQuantity?: unknown;
}

/**
 * What a modifier costs, from what the operator actually declared.
 *
 * Looks in the item's SHARED modifier groups first, then falls back to the
 * legacy per-item list. Both are honoured deliberately: groups are how a
 * menu is built now, and the old blob is still the truth for every menu
 * written before groups existed. A business must not find its prices stop
 * working because of a schema change it never asked for.
 *
 * A removal is always free and always allowed - a customer can ask for no
 * onions on anything. An addition the operator has not declared is carried
 * through as a kitchen NOTE rather than a priced modifier: charging
 * nothing for something that costs money would be wrong, and refusing the
 * order over an undeclared sauce would be worse. It reaches the line
 * either way, which is what the cook needs.
 */
function resolveModifier(
  modifier: ProposedModifier,
  item: FoodMenuItemRecord,
):
  | {
      priced: {
        name: string;
        action: ProposedModifier['action'];
        priceDeltaCents: number;
        quantity: number;
        freeQuantity: number;
      };
    }
  | { note: string } {
  // At least one, and whole. Somebody asking for "0.5 ketchup" is asking
  // for ketchup.
  const quantity = Math.max(1, Math.trunc(Number.isFinite(modifier.quantity ?? 1) ? (modifier.quantity ?? 1) : 1));

  if (modifier.action === 'remove') {
    return { priced: { name: modifier.name, action: 'remove', priceDeltaCents: 0, quantity, freeQuantity: quantity } };
  }

  const wanted = normalise(modifier.name);

  const fromGroup = item.modifierGroups
    .flatMap((group) => group.options)
    .find((option) => normalise(option.name) === wanted);

  if (fromGroup) {
    // An option the kitchen has run out of is not silently priced and
    // cooked - it is surfaced to the customer as a real problem, the same
    // way an unavailable item is.
    if (!fromGroup.available) {
      return { note: `${modifier.name} (UNAVAILABLE - check with the customer)` };
    }
    /* freeQuantity comes from the catalogue row read a moment ago, for
       exactly the same reason the price does: a proposal carrying either
       is carrying a guess. */
    return {
      priced: {
        name: fromGroup.name,
        action: modifier.action,
        priceDeltaCents: fromGroup.priceDeltaCents,
        quantity,
        freeQuantity: fromGroup.freeQuantity,
      },
    };
  }

  const declared = (item.modifiers as DeclaredModifier[]).find(
    (candidate) => typeof candidate?.name === 'string' && normalise(candidate.name) === wanted,
  );

  if (!declared) {
    return { note: modifier.action === 'on_side' ? `${modifier.name} on the side` : `extra ${modifier.name}` };
  }

  const delta = typeof declared.priceDeltaCents === 'number' ? declared.priceDeltaCents : 0;
  const free = typeof declared.freeQuantity === 'number' ? declared.freeQuantity : 0;
  return { priced: { name: modifier.name, action: modifier.action, priceDeltaCents: delta, quantity, freeQuantity: free } };
}

/**
 * The whole deterministic pipeline, run against the live catalogue.
 *
 * Returns every problem it finds rather than the first, so a customer is
 * asked about all of it at once instead of being led through one
 * correction at a time.
 */
export async function resolveProposal(
  repository: FoodOperationsRepository,
  businessId: string,
  proposal: DraftOrderProposal,
): Promise<ResolutionResult> {
  const problems: OrderProblem[] = [];
  const [menu, settings] = await Promise.all([repository.listMenu(businessId), repository.getSettings(businessId)]);

  if (proposal.fulfilmentMethod === 'DINE_IN' && !settings.tableServiceEnabled) {
    problems.push({
      kind: 'table_service_disabled',
      customerFacing: 'We are not taking table orders at the moment — would collection or delivery work?',
    });
  }

  if (proposal.lines.length === 0) {
    problems.push({ kind: 'no_items', customerFacing: 'I have not got anything on this order yet — what would you like?' });
  }

  const lines: FoodOrderLine[] = [];
  const currencies = new Set<string>();

  for (const proposed of proposal.lines) {
    /**
     * A price typed at the till for something the menu does not sell.
     *
     * Handled before the catalogue lookup and instead of it, never
     * alongside: a custom line has no menu item, gets no modifiers priced
     * against a group it does not belong to, and cannot be talked into
     * being a real dish at a different price. menuItemId stays null, which
     * the board already understands and shows as a hand-keyed line.
     */
    if (proposed.customAmountCents != null) {
      const amount = Math.max(0, Math.trunc(proposed.customAmountCents));
      const name = proposed.reference.trim() || 'Custom amount';
      // The currency has to come from somewhere real. The menu's is the
      // business's own; with no menu at all there is nothing to disagree
      // with, and the fallback below applies.
      if (menu[0]) currencies.add(menu[0].currency);
      lines.push({
        menuItemId: null,
        name,
        variant: null,
        quantity: Math.max(1, Math.floor(proposed.quantity)),
        unitPriceCents: amount,
        modifiers: [],
        notes: proposed.notes?.trim() || null,
      });
      continue;
    }

    const item = matchMenuItem(proposed.reference, menu);

    if (!item) {
      problems.push({
        kind: 'unknown_item',
        reference: proposed.reference,
        customerFacing: `I could not find "${proposed.reference}" on the menu — could you tell me which item you meant?`,
      });
      continue;
    }

    // The 86 gate. Checked at confirmation, not when the item was first
    // mentioned, because a kitchen runs out mid-conversation.
    if (!item.available) {
      problems.push({
        kind: 'unavailable',
        reference: proposed.reference,
        name: item.name,
        customerFacing: `Sorry — we have run out of ${item.name}. Would you like something else instead?`,
      });
      continue;
    }

    currencies.add(item.currency);

    const priced: FoodOrderLine['modifiers'] = [];
    const notes: string[] = [];
    for (const modifier of proposed.modifiers ?? []) {
      const resolvedModifier = resolveModifier(modifier, item);
      if ('priced' in resolvedModifier) priced.push(resolvedModifier.priced);
      else notes.push(resolvedModifier.note);
    }
    if (proposed.notes?.trim()) notes.push(proposed.notes.trim());

    lines.push({
      menuItemId: item.id,
      name: item.name,
      variant: null,
      quantity: Math.max(1, Math.floor(proposed.quantity)),
      // Straight from the catalogue row, read now. The single most
      // important line in this file.
      unitPriceCents: item.priceCents,
      modifiers: priced,
      notes: notes.length > 0 ? notes.join('; ') : null,
    });
  }

  if (currencies.size > 1) {
    problems.push({
      kind: 'mixed_currency',
      customerFacing: 'There is a problem with this order that we need to sort out by hand — someone will be with you shortly.',
    });
  }

  const currency = currencies.values().next().value ?? 'USD';
  /**
   * What the modifiers on one unit of a line actually cost.
   *
   * Through modifierCharge rather than summing priceDeltaCents, so an
   * option that comes partly free is charged for what is past the
   * allowance and not a cent more. With freeQuantity 0 - every option on
   * every menu written before migration 1045 - this is arithmetically
   * identical to the sum it replaces, so no existing price moves.
   *
   * Per unit, matching how modifiers have always been charged here: two
   * burgers with bacon pay for bacon twice, and "first sauce free" is per
   * burger, because that is what a kitchen means by it.
   */
  const modifiersPerUnit = (line: FoodOrderLine): number =>
    line.modifiers.reduce(
      (total, modifier) =>
        total + modifierCharge(modifier.quantity ?? 1, modifier.freeQuantity ?? 0, modifier.priceDeltaCents).totalCents,
      0,
    );

  const subtotalCents = lines.reduce(
    (sum, line) => sum + line.quantity * (line.unitPriceCents + modifiersPerUnit(line)),
    0,
  );

  let deliveryFeeCents = 0;
  if (proposal.fulfilmentMethod === 'DELIVERY') {
    if (proposal.deliveryLatitude == null || proposal.deliveryLongitude == null) {
      problems.push({
        kind: 'delivery_location_missing',
        // A dropped pin rather than a typed address: it cannot be
        // misspelled, and it is what the driver actually navigates to.
        customerFacing: 'Could you share your location so the driver knows exactly where to go? Tap the paperclip in WhatsApp, then Location.',
      });
    } else {
      const zones = await repository.listZones(businessId);
      // No zones configured is not a refusal - a business that has not set
      // its delivery area up still delivers, it just has no fee tiers yet.
      if (zones.length > 0) {
        const check = checkDelivery(
          { latitude: proposal.deliveryLatitude, longitude: proposal.deliveryLongitude },
          subtotalCents,
          zones,
        );
        if (check.deliverable) {
          deliveryFeeCents = check.feeCents;
        } else if (check.reason === 'OUT_OF_RANGE') {
          problems.push({
            kind: 'delivery_out_of_range',
            nearestZoneMetres: check.nearestZoneMetres,
            customerFacing: 'That is outside the area we deliver to, sorry — you are welcome to collect it if that suits.',
          });
        } else {
          problems.push({
            kind: 'delivery_below_minimum',
            minimumOrderCents: check.minimumOrderCents,
            customerFacing: `We deliver on orders over ${(check.minimumOrderCents / 100).toFixed(2)} — would you like to add anything, or collect instead?`,
          });
        }
      }
    }
  }

  if (problems.length > 0) return { ok: false, problems };

  /* One place works out what an order comes to - see orderTotals.ts for the
     order of operations and why it is that one. The settings were already
     read at the top of this function. */
  const totals = computeOrderTotals({
    itemsSubtotalCents: subtotalCents,
    deliveryFeeCents,
    requestedDiscountCents: proposal.discountCents ?? 0,
    tax: { rateBasisPoints: settings.taxRateBasisPoints, inclusive: settings.taxInclusive },
  });

  return {
    ok: true,
    resolved: {
      lines,
      subtotalCents: totals.itemsSubtotalCents,
      discountCents: totals.discountCents,
      deliveryFeeCents: totals.deliveryFeeCents,
      taxCents: totals.taxCents,
      totalCents: totals.totalCents,
      currency,
    },
  };
}

export interface ConfirmedOrder {
  order: import('../../repositories/foodOperationsRepository.js').FoodOrderRecord;
  /** What to send the customer now - the payment notice, or null when none applies. See paymentNotice.ts. */
  notice: string | null;
  /** True when this exact confirmation had already been processed and the existing order was returned. */
  deduplicated: boolean;
}

export type ConfirmResult = { ok: true; confirmed: ConfirmedOrder } | { ok: false; problems: OrderProblem[] };

/**
 * The customer said yes. This is where an order becomes real.
 *
 * Re-resolves from scratch rather than trusting anything computed earlier:
 * between the quote and the yes, an item can sell out and a price can
 * change, and the total somebody agreed to has to be the total the
 * catalogue actually supports at this moment. A resolution that now fails
 * is returned as problems, not forced through - the honest outcome is to
 * go back to the customer, not to cook something we cannot price.
 *
 * The idempotency key comes from the confirming MESSAGE, so a repeated
 * webhook, a double tap, and a worker retry all resolve to one ticket.
 */
export async function confirmProposal(
  repository: FoodOperationsRepository,
  businessId: string,
  proposal: DraftOrderProposal,
  options: { idempotencyKey?: string | null } = {},
): Promise<ConfirmResult> {
  // Answered before any work is done, so a replayed confirmation never
  // re-reads a catalogue that has moved on and never reports a problem
  // about an order that was already taken successfully.
  if (options.idempotencyKey) {
    const existing = await repository.findOrderByIdempotencyKey(businessId, options.idempotencyKey);
    if (existing) {
      const settings = await repository.getSettings(businessId);
      const { paymentRequiredNotice } = await import('./paymentNotice.js');
      return { ok: true, confirmed: { order: existing, notice: paymentRequiredNotice(existing, settings), deduplicated: true } };
    }
  }

  const resolution = await resolveProposal(repository, businessId, proposal);
  if (!resolution.ok) return { ok: false, problems: resolution.problems };

  const order = await repository.createOrder({
    businessId,
    idempotencyKey: options.idempotencyKey ?? null,
    chatId: proposal.chatId ?? null,
    customerContactId: proposal.customerContactId ?? null,
    fulfilmentMethod: proposal.fulfilmentMethod,
    customerName: proposal.customerName ?? null,
    customerPhone: proposal.customerPhone ?? null,
    items: resolution.resolved.lines,
    subtotalCents: resolution.resolved.subtotalCents,
    deliveryFeeCents: resolution.resolved.deliveryFeeCents,
    // Frozen onto the order from THIS resolution, not read back from
    // settings later: a rate changed in April must not rewrite March, and a
    // discount is a decision somebody made at a moment.
    taxCents: resolution.resolved.taxCents,
    discountCents: resolution.resolved.discountCents,
    discountReason: proposal.discountReason?.trim() || null,
    totalCents: resolution.resolved.totalCents,
    currency: resolution.resolved.currency,
    deliveryLatitude: proposal.deliveryLatitude ?? null,
    deliveryLongitude: proposal.deliveryLongitude ?? null,
    deliveryAddress: proposal.deliveryAddress ?? null,
    deliveryNotes: proposal.deliveryNotes ?? null,
    tableLabel: proposal.tableLabel ?? null,
    scheduledFor: proposal.scheduledFor ?? null,
    allergenNotes: proposal.allergenNotes ?? null,
    kitchenNotes: proposal.kitchenNotes ?? null,
  });

  const settings = await repository.getSettings(businessId);
  const { paymentRequiredNotice } = await import('./paymentNotice.js');

  return { ok: true, confirmed: { order, notice: paymentRequiredNotice(order, settings), deduplicated: false } };
}
