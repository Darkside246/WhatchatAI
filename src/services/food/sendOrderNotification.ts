import { pool } from '../../db/pool.js';
import { FoodOperationsRepository, type FoodOrderRecord } from '../../repositories/foodOperationsRepository.js';
import { WhatsAppChatRepository } from '../../repositories/whatsappChatRepository.js';
import { whatsappOutboundMessageService } from '../whatsappOutboundMessageService.js';
import { notificationFor, type FoodNotificationEvent } from './orderNotifications.js';

const repository = new FoodOperationsRepository(pool);
const chatRepository = new WhatsAppChatRepository(pool);

export type NotificationOutcome =
  | { sent: true; body: string }
  /** Not a failure: the business does not send this one, the order has no conversation, or the customer was already told. */
  | { sent: false; reason: 'not_enabled' | 'no_conversation' | 'already_told' | 'send_failed' };

/**
 * Tells the customer about one thing that happened to their order.
 *
 * CLAIMED BEFORE SENT, never the other way round. The claim is a unique
 * insert, so two workers bumping the same ticket cannot both get through
 * it - whereas checking first and then sending would let them. A send that
 * then fails leaves the claim in place with no outbound id, which is
 * deliberate: the record says somebody tried, which is exactly what is
 * needed when a customer says they heard nothing.
 *
 * NEVER THROWS. A notification is the last thing that should be able to
 * break a kitchen. An order that has been cooked has been cooked whether
 * or not the customer heard about it, so every failure here is recorded
 * and returned, not raised.
 */
export async function sendOrderNotification(
  order: FoodOrderRecord,
  event: FoodNotificationEvent,
): Promise<NotificationOutcome> {
  try {
    const settings = await repository.getSettings(order.businessId);

    // Looked up only for the message that could name a driver. Every other
    // event would be paying for a query whose answer it cannot use.
    const driverName =
      event === 'OUT_FOR_DELIVERY'
        ? (await repository.findLiveDelivery(order.businessId, order.id))?.driverName ?? null
        : null;

    const body = notificationFor(event, order, settings, { driverName });

    // notificationFor already returns null for an order with no
    // conversation, so the two are separated here only to give the caller
    // an honest reason rather than one catch-all.
    if (!body) return { sent: false, reason: order.chatId ? 'not_enabled' : 'no_conversation' };
    if (!order.chatId) return { sent: false, reason: 'no_conversation' };

    const claimed = await repository.claimNotification(order.businessId, order.id, event, body);
    if (!claimed) return { sent: false, reason: 'already_told' };

    // The account comes from the chat rather than being threaded through
    // every caller: an order's conversation is the authority on which
    // WhatsApp number it belongs to.
    const chat = await chatRepository.findByIdForBusiness(order.chatId, order.businessId);
    if (!chat) return { sent: false, reason: 'no_conversation' };

    const outbound = await whatsappOutboundMessageService.send({
      businessId: order.businessId,
      whatsappAccountId: chat.whatsappAccountId,
      chatId: order.chatId,
      // Derived from the order and the event, so a redelivered job reaches
      // the same outbound row rather than sending twice.
      idempotencyKey: `food-notify:${order.id}:${event}`,
      messageType: 'text',
      text: body,
      requestedBy: 'system',
    });

    await repository
      .attachNotificationOutbound(order.businessId, order.id, event, outbound.id)
      .catch(() => undefined);

    return { sent: true, body };
  } catch (error) {
    console.error(
      `[foodNotifications] Could not tell the customer about ${event} on order ${order.id}:`,
      error instanceof Error ? error.message : error,
    );
    return { sent: false, reason: 'send_failed' };
  }
}
