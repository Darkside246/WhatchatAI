import { z } from 'zod';

export const FoodOrderStatusSchema = z.enum([
  'BROWSING',
  'COLLECTING_ORDER',
  'NEEDS_CLARIFICATION',
  'NEEDS_CUSTOMER_DETAILS',
  'READY_TO_CONFIRM',
  'CONFIRMED',
  'CANCELLED',
  'HUMAN_REVIEW',
]);
export type FoodOrderStatus = z.infer<typeof FoodOrderStatusSchema>;

export const FulfilmentMethodSchema = z.enum(['PICKUP', 'DELIVERY']);
export type FulfilmentMethod = z.infer<typeof FulfilmentMethodSchema>;

export const FoodMenuItemSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  price: z.number().nonnegative(),
  available: z.boolean().default(true),
  aliases: z.array(z.string()).default([]),
  options: z.record(z.string(), z.array(z.object({ name: z.string().min(1), priceDelta: z.number() }))).default({}),
});
export type FoodMenuItem = z.infer<typeof FoodMenuItemSchema>;

export const FoodOrderLineSchema = z.object({
  itemId: z.string(),
  name: z.string(),
  quantity: z.number().int().positive(),
  unitPrice: z.number().nonnegative(),
  selectedOptions: z.record(z.string(), z.string()).default({}),
});
export type FoodOrderLine = z.infer<typeof FoodOrderLineSchema>;

export const FoodOrderStateSchema = z.object({
  conversationId: z.string(),
  tenantId: z.string(),
  customerAddress: z.string().optional(),
  customerName: z.string().optional(),
  customerPhone: z.string().optional(),
  fulfilmentMethod: FulfilmentMethodSchema.optional(),
  requestedTime: z.string().optional(),
  lines: z.array(FoodOrderLineSchema),
  status: FoodOrderStatusSchema,
  pendingQuestion: z.string().optional(),
  notes: z.string().optional(),
});
export type FoodOrderState = z.infer<typeof FoodOrderStateSchema>;

export type FoodOrderingResult = {
  state: FoodOrderState;
  reply: string;
  action?: 'CREATE_ORDER' | 'CANCEL_ORDER' | 'HUMAN_REVIEW';
};

const normalise = (text: string) => text.toLowerCase().replace(/[^a-z0-9$.'\s-]/g, ' ').replace(/\s+/g, ' ').trim();
const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wordBoundary = (text: string, phrase: string) => new RegExp(`\\b${escapeRegex(phrase)}\\b`, 'i').test(text);

export function detectFulfilment(text: string): FulfilmentMethod | undefined {
  const input = normalise(text);
  if (/\b(deliver|delivery|bring it|bring that|drop it|drop off|send it)\b/i.test(input)) return 'DELIVERY';
  if (/\b(pick ?up|collect|collection|come for it|coming for it)\b/i.test(input)) return 'PICKUP';
  return undefined;
}

export function detectCancellation(text: string): boolean {
  return /\b(cancel|cancel it|never mind|nevermind|forget it)\b/i.test(normalise(text));
}

export function detectConfirmation(text: string): boolean {
  return /^(yes|yeah|yep|yup|correct|that's right|thats right|confirm|confirmed|go ahead|send it|place it)$/i.test(normalise(text));
}

export function detectNegation(text: string): boolean {
  return /^(no|nah|not that|change that|hold on)$/i.test(normalise(text));
}

function findMenuItem(text: string, menu: FoodMenuItem[]): FoodMenuItem | undefined {
  const input = normalise(text);
  return menu.find((item) => [item.name, ...item.aliases].some((alias) => {
    const a = normalise(alias);
    return input === a || wordBoundary(input, a);
  }));
}

const quantityWords: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

export function parseQuantity(text: string): number {
  const input = normalise(text);
  const numeric = input.match(/\b(\d+)\b/);
  if (numeric) return Math.max(1, Number(numeric[1]));
  const word = input.match(/\b(a|an|one|two|three|four|five|six|seven|eight|nine|ten)\b/i);
  const quantityWord = word?.[1]?.toLowerCase();
  return quantityWord ? (quantityWords[quantityWord] ?? 1) : 1;
}

export function calculateOrderTotal(state: FoodOrderState, deliveryFee = 0): number {
  return Number((state.lines.reduce((sum, line) => sum + line.quantity * line.unitPrice, 0) + (state.fulfilmentMethod === 'DELIVERY' ? deliveryFee : 0)).toFixed(2));
}

function addSingleMenuItem(state: FoodOrderState, menu: FoodMenuItem[], text: string): FoodOrderState {
  const item = findMenuItem(text, menu);
  if (!item || !item.available) return state;
  const quantity = parseQuantity(text);
  const existing = state.lines.find((line) => line.itemId === item.id && Object.keys(line.selectedOptions).length === 0);
  const lines = existing
    ? state.lines.map((line) => line === existing ? { ...line, quantity: line.quantity + quantity } : line)
    : [...state.lines, { itemId: item.id, name: item.name, quantity, unitPrice: item.price, selectedOptions: {} }];
  return { ...state, lines, status: 'COLLECTING_ORDER', pendingQuestion: undefined };
}

export function addMenuItem(state: FoodOrderState, menu: FoodMenuItem[], text: string): FoodOrderState {
  const segments = normalise(text).split(/\s+(?:and|&|plus)\s+|[,;]\s*/).map((segment) => segment.trim()).filter(Boolean);
  return segments.reduce((current, segment) => addSingleMenuItem(current, menu, segment), state);
}

export function createInitialFoodOrder(tenantId: string, conversationId: string, customerPhone?: string): FoodOrderState {
  return customerPhone === undefined
    ? { tenantId, conversationId, lines: [], status: 'BROWSING' }
    : { tenantId, conversationId, customerPhone, lines: [], status: 'BROWSING' };
}

export function formatCart(state: FoodOrderState, deliveryFee = 0): string {
  if (!state.lines.length) return 'Your cart is empty.';
  const lines = state.lines.map((line) => `${line.quantity} x ${line.name} - ${(line.quantity * line.unitPrice).toFixed(2)}`);
  return `${lines.join('\n')}\nTotal: ${calculateOrderTotal(state, deliveryFee).toFixed(2)}`;
}
