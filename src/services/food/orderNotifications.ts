import type { FoodOrderStage } from '../../domain/food/orderLifecycle.js';
import type { FoodOrderRecord, FoodSettingsRecord } from '../../repositories/foodOperationsRepository.js';

/**
 * What the customer hears as their order moves.
 *
 * TIED TO THE STATE MACHINE, NEVER TO A JUDGEMENT. A cook bumping a ticket
 * is what makes an order ready. Nothing here asks a model whether it
 * probably is by now, because "your order is ready" is a promise a
 * business has to be able to keep - somebody may be walking out the door
 * on the strength of it.
 *
 * A PURE DECISION. This module works out WHAT to say and never sends
 * anything. The send, the deduplication and the failure handling belong to
 * the caller, which means the wording can be tested exhaustively without a
 * queue, a socket or a WhatsApp connection anywhere near it.
 */

export const FOOD_NOTIFICATION_EVENTS = [
  'ORDER_RECEIVED',
  'PAYMENT_CONFIRMED',
  'IN_KITCHEN',
  'READY_FOR_PICKUP',
  'OUT_FOR_DELIVERY',
  'COMPLETED',
] as const;

export type FoodNotificationEvent = (typeof FOOD_NOTIFICATION_EVENTS)[number];

export type NotificationVerbosity = 'MINIMAL' | 'STANDARD' | 'DETAILED' | 'CUSTOM';

/**
 * Which milestones each setting actually sends.
 *
 * MINIMAL is the two that require the customer to DO something - we have
 * your order, and come and get it. Everything else is a business talking
 * about itself.
 *
 * STANDARD is the default and adds the two that answer "has anything
 * happened?", which is the question that otherwise arrives as a message
 * somebody has to answer by hand.
 *
 * DETAILED adds the closing confirmation. Deliberately last, because a
 * customer holding the food already knows they have it.
 */
const VERBOSITY_EVENTS: Record<Exclude<NotificationVerbosity, 'CUSTOM'>, readonly FoodNotificationEvent[]> = {
  MINIMAL: ['ORDER_RECEIVED', 'READY_FOR_PICKUP', 'OUT_FOR_DELIVERY'],
  STANDARD: ['ORDER_RECEIVED', 'PAYMENT_CONFIRMED', 'IN_KITCHEN', 'READY_FOR_PICKUP', 'OUT_FOR_DELIVERY'],
  DETAILED: [...FOOD_NOTIFICATION_EVENTS],
};

/**
 * The shipped wording.
 *
 * Written as a person at a counter would say it: short, no exclamation
 * marks, no "we are delighted to inform you". An operator can replace any
 * of them, and most never will - which is why the defaults have to be good
 * enough to leave alone.
 */
export const DEFAULT_NOTIFICATION_TEMPLATES: Record<FoodNotificationEvent, string> = {
  ORDER_RECEIVED: 'Got your order — #{{order_number}}, {{total}}. We will let you know as it moves along.',
  PAYMENT_CONFIRMED: 'Payment received for #{{order_number}}, thank you. It is going to the kitchen now.',
  IN_KITCHEN: 'Your order is being made now.',
  READY_FOR_PICKUP: 'Order #{{order_number}} is ready whenever you are.',
  OUT_FOR_DELIVERY: 'Your order is on the way.',
  COMPLETED: 'That is #{{order_number}} all done — thanks for ordering with us.',
};

export interface NotificationOverride {
  enabled?: boolean;
  template?: string;
}

/** Per-event switches and wording. Only consulted under CUSTOM verbosity. */
export type NotificationOverrides = Partial<Record<FoodNotificationEvent, NotificationOverride>>;

/**
 * The stage change that causes each message.
 *
 * PAYMENT_CONFIRMED and ORDER_RECEIVED are absent because they are not
 * stage changes - they are caused by an order being taken and by money
 * arriving, which the caller signals directly.
 */
const EVENT_FOR_STAGE: Partial<Record<FoodOrderStage, FoodNotificationEvent>> = {
  IN_KITCHEN: 'IN_KITCHEN',
  READY_FOR_PICKUP: 'READY_FOR_PICKUP',
  OUT_FOR_DELIVERY: 'OUT_FOR_DELIVERY',
  COMPLETED: 'COMPLETED',
};

export function eventForStage(stage: FoodOrderStage): FoodNotificationEvent | null {
  return EVENT_FOR_STAGE[stage] ?? null;
}

export function isNotificationEnabled(
  event: FoodNotificationEvent,
  verbosity: NotificationVerbosity,
  overrides: NotificationOverrides = {},
): boolean {
  if (verbosity === 'CUSTOM') {
    // Under CUSTOM, silence is the default: an operator who has taken
    // control of their own messages has said nothing about an event they
    // have not switched on.
    return overrides[event]?.enabled === true;
  }
  return VERBOSITY_EVENTS[verbosity].includes(event);
}

function formatMoney(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

export const NOTIFICATION_MERGE_FIELDS = [
  { token: '{{name}}', description: "The customer's name, or nothing when it is not known" },
  { token: '{{order_number}}', description: "The order's own number" },
  { token: '{{total}}', description: 'The order total, in the order currency' },
] as const;

/**
 * The message for this event, or null when the business does not send it.
 *
 * Returns null rather than an empty string so a caller cannot accidentally
 * send silence to a customer as a blank WhatsApp message.
 */
export function notificationFor(
  event: FoodNotificationEvent,
  order: FoodOrderRecord,
  settings: FoodSettingsRecord,
): string | null {
  const verbosity = settings.notificationVerbosity;
  const overrides = settings.notificationOverrides;

  if (!isNotificationEnabled(event, verbosity, overrides)) return null;

  // A counter order has no conversation, so there is nobody to message.
  // Checked here rather than left to the caller, because a notification
  // with no recipient is not a send that failed - it is one that should
  // never have been attempted.
  if (!order.chatId) return null;

  const template =
    (verbosity === 'CUSTOM' ? overrides[event]?.template?.trim() : undefined) || DEFAULT_NOTIFICATION_TEMPLATES[event];

  const rendered = template
    .replaceAll('{{name}}', order.customerName?.trim() ?? '')
    .replaceAll('{{order_number}}', String(order.orderNumber))
    .replaceAll('{{total}}', formatMoney(order.totalCents, order.currency))
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.])/g, '$1')
    .trim();

  return rendered.length > 0 ? rendered : null;
}

/**
 * The closing message depends on how they got it.
 *
 * "Delivered" to somebody who walked in and collected it reads as a
 * mistake, and a mistake in the last message of a transaction is the one
 * they remember.
 */
export function completionWording(order: FoodOrderRecord): string {
  return order.fulfilmentMethod === 'DELIVERY' ? 'delivered' : 'collected';
}
