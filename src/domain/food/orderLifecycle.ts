/**
 * How a food order actually moves through a kitchen.
 *
 * Modelled on how a real service line runs rather than on a generic status
 * field: an order is taken, it goes to the line, it is checked before it
 * leaves, and then it either waits on a counter for the customer or goes
 * out with a driver. Each of those is a different person's screen, and the
 * handover between them is the thing that goes wrong under pressure.
 *
 * The states are deliberately few. Every one of them answers "whose job is
 * this right now" - which is the only question a board needs to settle
 * during a rush.
 */

export const FOOD_ORDER_STAGES = [
  /** Taken, not yet accepted by the kitchen. The only stage where the order can still be changed freely. */
  'NEW',
  /** Accepted and being cooked. The SLA clock that matters runs from here. */
  'IN_KITCHEN',
  /** Cooked, waiting on the expediter to check modifiers, allergens and packing before it leaves the pass. */
  'QUALITY_CHECK',
  /** Checked and sitting on the counter for a customer who is collecting. */
  'READY_FOR_PICKUP',
  /** Checked, packed and with a driver. */
  'OUT_FOR_DELIVERY',
  /** Collected or delivered. */
  'COMPLETED',
  'CANCELLED',
] as const;

export type FoodOrderStage = (typeof FOOD_ORDER_STAGES)[number];

export type FulfilmentMethod = 'PICKUP' | 'DELIVERY';

/**
 * Which stages an order may move to next.
 *
 * A map rather than scattered if-statements, so the whole set of legal
 * moves can be read at once - and so a board, an API route and the AI all
 * agree on what is possible instead of each deciding for itself.
 *
 * Backward moves are allowed where a real kitchen needs them: an expediter
 * who finds a missing side sends the ticket back to the line, and a bump
 * bar pressed by accident has to be undoable. They are NOT allowed once an
 * order has left the building, because at that point the food is gone and
 * pretending otherwise would make the board lie.
 */
const ALLOWED_TRANSITIONS: Record<FoodOrderStage, readonly FoodOrderStage[]> = {
  NEW: ['IN_KITCHEN', 'CANCELLED'],
  // Back to NEW covers a ticket accepted by mistake.
  IN_KITCHEN: ['QUALITY_CHECK', 'NEW', 'CANCELLED'],
  // Back to the line when the check fails - a missing sauce, a wrong side.
  QUALITY_CHECK: ['READY_FOR_PICKUP', 'OUT_FOR_DELIVERY', 'IN_KITCHEN', 'CANCELLED'],
  // Still recoverable: the customer has not taken it yet.
  READY_FOR_PICKUP: ['COMPLETED', 'QUALITY_CHECK', 'CANCELLED'],
  // A driver who has left cannot un-leave. Cancelling remains possible
  // because a delivery can genuinely fail, but it can never go back to the
  // pass as though the food were still there.
  OUT_FOR_DELIVERY: ['COMPLETED', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
};

/** The stages an order can still be worked on - what a board shows by default. */
export const OPEN_STAGES: readonly FoodOrderStage[] = ['NEW', 'IN_KITCHEN', 'QUALITY_CHECK', 'READY_FOR_PICKUP', 'OUT_FOR_DELIVERY'];

export function isOpenStage(stage: FoodOrderStage): boolean {
  return OPEN_STAGES.includes(stage);
}

export function canTransition(from: FoodOrderStage, to: FoodOrderStage): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function allowedNextStages(from: FoodOrderStage): readonly FoodOrderStage[] {
  return ALLOWED_TRANSITIONS[from];
}

/**
 * Where an order goes when it clears the quality check.
 *
 * The one branch in the whole flow, and it is decided by how the customer
 * said they wanted it - never by whoever happens to be on the pass.
 */
export function stageAfterQualityCheck(fulfilment: FulfilmentMethod): FoodOrderStage {
  return fulfilment === 'DELIVERY' ? 'OUT_FOR_DELIVERY' : 'READY_FOR_PICKUP';
}

/**
 * The next stage a "bump" moves an order to - one button, the same gesture
 * at every station, which is how a line actually works. Null once there is
 * nothing left to bump.
 */
export function bumpTarget(stage: FoodOrderStage, fulfilment: FulfilmentMethod): FoodOrderStage | null {
  switch (stage) {
    case 'NEW':
      return 'IN_KITCHEN';
    case 'IN_KITCHEN':
      return 'QUALITY_CHECK';
    case 'QUALITY_CHECK':
      return stageAfterQualityCheck(fulfilment);
    case 'READY_FOR_PICKUP':
    case 'OUT_FOR_DELIVERY':
      return 'COMPLETED';
    default:
      return null;
  }
}

// ── The SLA clock ────────────────────────────────────────────────────────

/**
 * How long an order has been waiting, and how alarmed the board should be
 * about it.
 *
 * The bands are the ones a kitchen screen has used for years: under ten
 * minutes is normal, the next five are a warning, and past fifteen the
 * ticket is late and needs to go to the front of the queue. They are
 * configurable per business because a bakery's custom cake and a burger
 * have nothing in common, but these are the defaults.
 */
export const DEFAULT_SLA_WARNING_SECONDS = 10 * 60;
export const DEFAULT_SLA_BREACH_SECONDS = 15 * 60;

export type SlaBand = 'ON_TIME' | 'WARNING' | 'BREACHED';

export interface SlaThresholds {
  warningSeconds?: number;
  breachSeconds?: number;
}

export function slaBand(elapsedSeconds: number, thresholds: SlaThresholds = {}): SlaBand {
  const warning = thresholds.warningSeconds ?? DEFAULT_SLA_WARNING_SECONDS;
  const breach = thresholds.breachSeconds ?? DEFAULT_SLA_BREACH_SECONDS;
  if (elapsedSeconds >= breach) return 'BREACHED';
  if (elapsedSeconds >= warning) return 'WARNING';
  return 'ON_TIME';
}

/**
 * Seconds an order has been live.
 *
 * Measured from when the order was PLACED, not from when the kitchen got
 * round to accepting it. A ticket that sat unnoticed for eight minutes is
 * already eight minutes late to the customer, and a clock that started at
 * acceptance would hide exactly the delay worth seeing.
 *
 * Stops at completion or cancellation, so a finished order does not go on
 * turning redder in a history view.
 */
export function elapsedSeconds(order: { placedAt: string; stage: FoodOrderStage; closedAt: string | null }, now: Date = new Date()): number {
  const placed = new Date(order.placedAt).getTime();
  if (Number.isNaN(placed)) return 0;
  const end = isOpenStage(order.stage) || !order.closedAt ? now.getTime() : new Date(order.closedAt).getTime();
  return Math.max(0, Math.floor((end - placed) / 1000));
}
