import { pool } from '../../db/pool.js';
import { FoodOperationsRepository, type FoodOrderRecord, type FoodPaymentRequestRecord } from '../../repositories/foodOperationsRepository.js';
import { WhatsAppChatRepository } from '../../repositories/whatsappChatRepository.js';
import { whatsappOutboundMessageService } from '../whatsappOutboundMessageService.js';
import { buildPaymentAsk } from './paymentRequest.js';
import { PAYMENT_METHOD_CAPABILITIES } from '../../domain/food/paymentMethods.js';

const repository = new FoodOperationsRepository(pool);
const chatRepository = new WhatsAppChatRepository(pool);

/**
 * Asking the customer for the money, over the conversation the order came
 * from.
 *
 * This is the automatable half of "send a BiMPay request when the order is
 * taken". The amount comes from the order, so it is right by construction
 * rather than by somebody retyping it; the alias comes from the business's
 * settings; the order number goes in as the reference so six transfers at
 * closing time can still be told apart.
 *
 * NEVER THROWS, for the same reason the order notifications never do: an
 * order that has been taken has been taken whether or not the ask went
 * out, and a messaging failure must not break the board. Every outcome is
 * returned rather than raised.
 */

export type PaymentAskOutcome =
  | { sent: true; request: FoodPaymentRequestRecord }
  | { sent: false; reason: string; request?: FoodPaymentRequestRecord };

export async function sendPaymentRequest(
  order: FoodOrderRecord,
  options: { requestedBy?: string | null; method?: string | null } = {},
): Promise<PaymentAskOutcome> {
  try {
    const methods = await repository.listPaymentMethods(order.businessId);
    const enabled = methods.filter((entry) => entry.enabled);

    // The method asked for, else the preferred one, else the only enabled
    // one. Deliberately no silent fallback past that: asking for money
    // through a route the business did not choose is worse than not asking.
    const chosen = options.method
      ? enabled.find((entry) => entry.method === options.method)
      : (enabled.find((entry) => entry.preferred) ?? (enabled.length === 1 ? enabled[0] : undefined));

    if (!chosen) {
      return {
        sent: false,
        reason: enabled.length === 0
          ? 'No way of being paid is switched on yet.'
          : 'More than one payment method is on and none is marked preferred, so nothing was sent.',
      };
    }

    const ask = buildPaymentAsk(order, chosen.method, {
      alias: chosen.alias,
      instructions: chosen.instructions,
      ...(chosen.aliasKind ? { aliasKind: chosen.aliasKind } : {}),
    });
    if (!ask.message) return { sent: false, reason: ask.reason ?? 'There was nothing to send.' };

    // A counter order has no conversation, so there is nobody to ask.
    // Recorded anyway: the business still has to collect the money, and a
    // request nobody can see is a request nobody chases.
    if (!order.chatId) {
      const request = await repository.recordPaymentRequest({
        businessId: order.businessId,
        orderId: order.id,
        method: chosen.method,
        amountCents: order.totalCents,
        currency: order.currency,
        aliasAtRequest: chosen.alias,
        messageSent: null,
        requestedBy: options.requestedBy ?? null,
      });
      return { sent: false, reason: 'This order has no conversation, so the customer could not be messaged.', request };
    }

    const chat = await chatRepository.findByIdForBusiness(order.chatId, order.businessId);
    if (!chat) return { sent: false, reason: 'That conversation could not be found.' };

    const outbound = await whatsappOutboundMessageService.send({
      businessId: order.businessId,
      whatsappAccountId: chat.whatsappAccountId,
      chatId: order.chatId,
      // Derived from the order and the method, so a retried job or a double
      // tap reaches the same outbound row rather than asking twice. A
      // deliberate second ask is a chase, which carries its own key below.
      idempotencyKey: `food-payment-ask:${order.id}:${chosen.method}`,
      messageType: 'text',
      text: ask.message,
      // 'system' rather than 'ai': the wording is ours and fixed, not
      // generated, and an operator reading the thread should not be told a
      // model composed a sentence it did not.
      requestedBy: 'system',
    });

    const request = await repository.recordPaymentRequest({
      businessId: order.businessId,
      orderId: order.id,
      method: chosen.method,
      amountCents: order.totalCents,
      currency: order.currency,
      aliasAtRequest: chosen.alias,
      messageSent: ask.message,
      outboundMessageId: outbound?.id ?? null,
      requestedBy: options.requestedBy ?? null,
    });

    return { sent: true, request };
  } catch (error) {
    // Returned, never raised. The order exists either way.
    return { sent: false, reason: error instanceof Error ? error.message : 'The payment request could not be sent.' };
  }
}

/** Whether this method expects a person to confirm the money arrived. Used by the board to offer the right button. */
export function needsHumanConfirmation(method: string): boolean {
  const capability = PAYMENT_METHOD_CAPABILITIES[method as keyof typeof PAYMENT_METHOD_CAPABILITIES];
  return capability ? capability.confirmation === 'MANUAL' : true;
}
