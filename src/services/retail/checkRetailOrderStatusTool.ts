import { Type } from '@google/genai';
import type { FunctionDeclaration } from '@google/genai';

export const CHECK_RETAIL_ORDER_STATUS_TOOL_NAME = 'check_retail_order_status';

/**
 * READ-tier: reports the real status of an order this customer placed.
 * Deliberately read-only: a new order request already goes through the
 * dedicated triage/approval pipeline (retailOrderOrchestrator.ts's
 * runRetailOrderHandoff, which runs before this conversational path even
 * sees the message) - this tool exists for "what's the status of what I
 * already ordered."
 *
 * Scoping (retail's version of the Section 75-91 privacy safeguard
 * property's check_property_status uses): retail has no per-chat binding
 * table to scope by, so this tool must instead scope by the chat's own
 * resolved customer identity (context.customerId, the same crmContact/
 * customer resolution aiContextGathererService.ts already does for every
 * reply) - filter to that customer's own orders first, THEN fuzzy-match the
 * free-text orderReference within that filtered set. The free-text
 * argument alone must never be allowed to select an order across the whole
 * business, or one customer could read back another customer's real order
 * details just by guessing an order reference.
 */
export const checkRetailOrderStatusFunctionDeclaration: FunctionDeclaration = {
  name: CHECK_RETAIL_ORDER_STATUS_TOOL_NAME,
  description:
    'Looks up a real order this customer placed (by an order reference or description they give you, not an internal ID) ' +
    'and reports its current status. Use this to answer "where is my order" or "has it shipped yet". If no order matches, ' +
    'or more than one does, this tool tells you so - ask the customer to clarify rather than guessing which order they mean.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      orderReference: {
        type: Type.STRING,
        description: 'The order number or description the customer used, e.g. "order #1234" or "the shirts I ordered yesterday". Required.',
      },
    },
    required: ['orderReference'],
  },
};

export interface CheckRetailOrderStatusToolArgs {
  orderReference: string;
}
