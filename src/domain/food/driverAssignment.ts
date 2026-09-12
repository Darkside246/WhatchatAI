/**
 * Who has the food.
 *
 * Once an order leaves the building it stops being a kitchen problem and
 * becomes a whereabouts problem, and a board that says "out for delivery"
 * and nothing else cannot answer the only question anybody asks about it.
 * So a delivery carries a named person and a state of its own, alongside
 * the order's stage rather than inside it.
 *
 * Deliberately NOT in this release: automatic dispatch, routing, batching,
 * live driver tracking. A dispatcher that assigns the wrong driver by
 * itself is worse than no dispatcher, and none of it is worth anything
 * until a business is reliably recording who took what by hand. Every
 * assignment here is a person choosing a person.
 */

export const DRIVER_ASSIGNMENT_STATES = [
  /** Given to a driver. The food may still be on the pass. */
  'ASSIGNED',
  /** The driver physically has it. */
  'COLLECTED',
  'DELIVERED',
  /** Nobody was there, the address was wrong, the customer refused it. */
  'FAILED',
  /** Came back to the shop, whether or not the attempt failed. */
  'RETURNED',
  /** Undone before the driver took anything - the wrong name tapped on a list. */
  'CANCELLED',
] as const;

export type DriverAssignmentState = (typeof DRIVER_ASSIGNMENT_STATES)[number];

/**
 * Where an assignment may go next.
 *
 * ASSIGNED can be undone - a driver picked from a list by mistake has to
 * be unpickable, and reassigning before anybody moves is normal. Once the
 * food is COLLECTED the assignment can no longer be cancelled, only
 * finished: the driver is holding it, and a record that says otherwise is
 * a record that lies about where somebody's dinner is.
 */
const ALLOWED: Record<DriverAssignmentState, readonly DriverAssignmentState[]> = {
  ASSIGNED: ['COLLECTED', 'CANCELLED', 'FAILED'],
  COLLECTED: ['DELIVERED', 'FAILED', 'RETURNED'],
  // A failed attempt is not the end: the food is still in a car and has to
  // come back, or be re-attempted.
  FAILED: ['RETURNED', 'COLLECTED'],
  DELIVERED: [],
  RETURNED: [],
  CANCELLED: [],
};

/** States where the driver still has the food and the order is genuinely in motion. */
export const IN_MOTION_STATES: readonly DriverAssignmentState[] = ['ASSIGNED', 'COLLECTED', 'FAILED'];

export function canTransitionAssignment(from: DriverAssignmentState, to: DriverAssignmentState): boolean {
  return (ALLOWED[from] ?? []).includes(to);
}

/** True once nothing more will happen to this assignment. */
export function isFinalAssignmentState(state: DriverAssignmentState): boolean {
  return (ALLOWED[state] ?? []).length === 0;
}

/**
 * Whether a driver may be put on this order at all.
 *
 * Stated as a reason rather than a boolean, because every one of these is
 * something a person on a screen has to be told. An assignment silently
 * not happening is how an order ends up with nobody looking for it.
 */
export function whyNotAssignable(order: {
  fulfilmentMethod: 'PICKUP' | 'DELIVERY' | 'DINE_IN';
  stage: string;
}): string | null {
  if (order.fulfilmentMethod !== 'DELIVERY') {
    return order.fulfilmentMethod === 'DINE_IN'
      ? 'This one is eating in.'
      : 'This one is being collected, so nobody is driving it anywhere.';
  }
  if (order.stage === 'CANCELLED') return 'This order was cancelled.';
  if (order.stage === 'COMPLETED') return 'This order is already finished.';
  return null;
}
