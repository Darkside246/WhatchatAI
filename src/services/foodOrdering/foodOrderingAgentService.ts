import { randomUUID } from 'node:crypto';
import type { ActionRequest, CommunicationEvent } from '../../domain/platform/contracts.js';
import {
  addMenuItem,
  calculateOrderTotal,
  createInitialFoodOrder,
  detectCancellation,
  detectConfirmation,
  detectFulfilment,
  formatCart,
  type FoodMenuItem,
  type FoodOrderState,
  type FoodOrderingResult,
} from './foodOrderingPolicy.js';

export type FoodOrderingContext = {
  menu: FoodMenuItem[];
  deliveryFee?: number;
  openingHours?: string;
  acceptsDelivery?: boolean;
};

function action(input: {
  tenantId: string;
  conversationId: string;
  type: string;
  payload: Record<string, unknown>;
  riskLevel: ActionRequest['riskLevel'];
  approvalRequired: boolean;
}): ActionRequest {
  return {
    id: randomUUID(),
    tenantId: input.tenantId,
    type: input.type,
    payload: input.payload,
    requestedBy: { kind: 'AGENT', id: 'buzz-food-ordering' },
    riskLevel: input.riskLevel,
    approval: { required: input.approvalRequired, status: input.approvalRequired ? 'PENDING' : 'NOT_REQUIRED' },
    status: input.approvalRequired ? 'PENDING_APPROVAL' : 'PENDING_POLICY',
    idempotencyKey: `food-order:${input.tenantId}:${input.conversationId}:${input.type}`,
    correlationId: input.conversationId,
    createdAt: new Date().toISOString(),
  };
}

function menuText(menu: FoodMenuItem[]): string {
  const available = menu.filter((item) => item.available);
  if (!available.length) return 'I’m sorry, we do not have the menu available right now. I can get someone from the shop to help you.';
  return available.map((item) => `${item.name} - ${item.price.toFixed(2)}${item.description ? ` (${item.description})` : ''}`).join('\n');
}

function askForFulfilment(context: FoodOrderingContext): string {
  if (context.acceptsDelivery === false) return 'Is this for pickup?';
  return 'Would you like to pick it up or have it delivered?';
}

export function runFoodOrderingTurn(input: {
  event: CommunicationEvent;
  state?: FoodOrderState;
  context: FoodOrderingContext;
}): FoodOrderingResult {
  const state = input.state ?? createInitialFoodOrder(input.event.tenantId, input.event.conversationId, input.event.sender.address);
  const text = input.event.message.text?.trim() ?? '';

  if (!text) {
    return { state: { ...state, status: 'NEEDS_CLARIFICATION', pendingQuestion: 'What would you like to order?' }, reply: 'Sure. What would you like to order?' };
  }

  if (detectCancellation(text)) {
    if (!state.lines.length) {
      return {
        state: { ...state, status: 'CANCELLED', pendingQuestion: undefined },
        reply: 'No problem. What can I help you with?',
      };
    }
    return {
      state: { ...state, status: 'CANCELLED', pendingQuestion: undefined },
      reply: 'No problem, I’ve cancelled this order. If you need anything else, just message me.',
      action: 'CANCEL_ORDER',
    };
  }

  const fulfilment = detectFulfilment(text);
  if (fulfilment) {
    const next = { ...state, fulfilmentMethod: fulfilment, status: state.lines.length ? 'NEEDS_CUSTOMER_DETAILS' as const : 'BROWSING' as const, pendingQuestion: undefined };
    if (!state.lines.length) return { state: next, reply: `Got you - ${fulfilment === 'PICKUP' ? 'pickup' : 'delivery'}. What would you like to order?` };
    if (fulfilment === 'DELIVERY') return { state: next, reply: 'Got you. What address should we deliver to?' };

    const ready = { ...next, status: 'READY_TO_CONFIRM' as const, pendingQuestion: undefined };
    return { state: ready, reply: `${formatCart(ready, input.context.deliveryFee ?? 0)}\n\nDoes that look right?` };
  }

  if (/\b(menu|what do you have|what's available|whats available|food|meals)\b/i.test(text)) {
    return { state: { ...state, status: 'BROWSING' }, reply: `Here’s what we have today:\n\n${menuText(input.context.menu)}\n\nJust tell me what you want - for example, “2 chicken roti and a macaroni pie”.` };
  }

  if (state.status === 'READY_TO_CONFIRM' && detectConfirmation(text)) {
    const total = calculateOrderTotal(state, input.context.deliveryFee ?? 0);
    return {
      state: { ...state, status: 'CONFIRMED', pendingQuestion: undefined },
      reply: `Perfect, your order is confirmed. Total: ${total.toFixed(2)}. I’ll keep you updated here.`,
      action: 'CREATE_ORDER',
    };
  }

  const nextWithItems = addMenuItem(state, input.context.menu, text);
  if (nextWithItems.lines.length > state.lines.length) {
    if (!nextWithItems.fulfilmentMethod) {
      return { state: { ...nextWithItems, status: 'COLLECTING_ORDER', pendingQuestion: undefined }, reply: `${formatCart(nextWithItems, 0)}\n\n${askForFulfilment(input.context)}` };
    }
    if (nextWithItems.fulfilmentMethod === 'DELIVERY' && !nextWithItems.customerAddress) {
      return { state: { ...nextWithItems, status: 'NEEDS_CUSTOMER_DETAILS', pendingQuestion: 'What address should we deliver to?' }, reply: `${formatCart(nextWithItems, input.context.deliveryFee ?? 0)}\n\nWhat address should we deliver to?` };
    }
    return { state: { ...nextWithItems, status: 'READY_TO_CONFIRM' }, reply: `${formatCart(nextWithItems, input.context.deliveryFee ?? 0)}\n\nDoes that look right?` };
  }

  if (state.status === 'NEEDS_CUSTOMER_DETAILS' && state.fulfilmentMethod === 'DELIVERY' && !state.customerAddress) {
    const next = { ...state, customerAddress: text, status: 'READY_TO_CONFIRM' as const, pendingQuestion: undefined };
    return { state: next, reply: `${formatCart(next, input.context.deliveryFee ?? 0)}\nDeliver to: ${text}\n\nDoes that look right?` };
  }

  if (state.status === 'NEEDS_CUSTOMER_DETAILS' && !state.customerName) {
    const next = { ...state, customerName: text, status: 'READY_TO_CONFIRM' as const, pendingQuestion: undefined };
    return { state: next, reply: `${formatCart(next, input.context.deliveryFee ?? 0)}\nName: ${text}\n\nDoes that look right?` };
  }

  if (state.lines.length) {
    return { state: { ...state, status: 'NEEDS_CLARIFICATION', pendingQuestion: 'What would you like me to change or add to your order?' }, reply: 'I have your order. What would you like me to change or add?' };
  }

  return {
    state: { ...state, status: 'HUMAN_REVIEW', pendingQuestion: undefined },
    reply: 'I want to make sure I get that right. I’ll have someone from the shop help you here.',
    action: 'HUMAN_REVIEW',
  };
}
