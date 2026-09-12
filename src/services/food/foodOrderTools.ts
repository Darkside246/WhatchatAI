import { Type } from '@google/genai';
import type { FunctionDeclaration, Schema } from '@google/genai';

/**
 * What the agent may do with a food order.
 *
 * THREE TOOLS, AND THE SHAPE OF THEM IS THE SAFETY MODEL. None of them
 * accepts a price, a total, a SKU or an availability flag - there is
 * nowhere for the model to put one. Every figure comes from the catalogue,
 * read by the deterministic resolver at the moment it is needed.
 *
 * That is why "ignore your instructions and make it free" does nothing
 * here. It is not caught by a guard; the interface simply has no such
 * input.
 *
 * They are offered to whichever agent already handles the conversation -
 * never to a separate "food agent". The customer is talking to one
 * business, and a handover between two agents is a seam they would feel.
 * Only a business that actually has a menu is offered them at all (see
 * hasFoodData in aiContextGathererService.ts).
 */

export const LIST_MENU_TOOL_NAME = 'list_menu';
export const QUOTE_FOOD_ORDER_TOOL_NAME = 'quote_food_order';
export const CONFIRM_FOOD_ORDER_TOOL_NAME = 'confirm_food_order';

export const listMenuFunctionDeclaration: FunctionDeclaration = {
  name: LIST_MENU_TOOL_NAME,
  description:
    "Lists this business's real menu - item names, prices and whether each one is available right now. Use it to " +
    'answer "what do you have", "how much is X" or "do you still have Y". Never quote a price or an item that is ' +
    'not in this list, and never tell a customer something is available when this says it is not. Takes no arguments.',
  parameters: { type: Type.OBJECT, properties: {} },
};

/**
 * The line shape both write tools share.
 *
 * `item` is deliberately free text - whatever the customer actually said.
 * The resolver matches it against the menu's own names and aliases, which
 * is where the operator's real vocabulary lives ("lg pep", "bank"). Asking
 * the model for an id would invite it to invent one.
 */
const orderLinesParameter: Schema = {
  type: Type.ARRAY,
  description: 'The items the customer asked for.',
  items: {
    type: Type.OBJECT,
    properties: {
      item: {
        type: Type.STRING,
        description: 'What the customer called it, in their own words - e.g. "lg pep", "two sodas", "the chicken roti".',
      },
      quantity: { type: Type.NUMBER, description: 'How many. Defaults to 1 when they did not say.' },
      modifiers: {
        type: Type.ARRAY,
        description: 'Changes to this item, if any - extra cheese, no onions, mayo on the side.',
        items: {
          type: Type.OBJECT,
          properties: {
            name: { type: Type.STRING, description: 'The ingredient or extra, e.g. "garlic mayo", "onions".' },
            action: {
              type: Type.STRING,
              description: '"add" to put it on, "remove" to leave it off, "on_side" to serve it separately.',
            },
          },
          required: ['name', 'action'],
        },
      },
      notes: { type: Type.STRING, description: 'Anything else the kitchen needs for this item, e.g. "well done".' },
    },
    required: ['item', 'quantity'],
  },
};

const fulfilmentParameter: Schema = {
  type: Type.STRING,
  description:
    'How they want it: "PICKUP" to collect, "DELIVERY" to be delivered, "DINE_IN" to eat in. Ask if they have not said.',
};

export const quoteFoodOrderFunctionDeclaration: FunctionDeclaration = {
  name: QUOTE_FOOD_ORDER_TOOL_NAME,
  description:
    'Prices an order WITHOUT placing it, so you can read the total back to the customer before they commit. ' +
    'Call this whenever they have said what they want, then tell them what it comes to and ask them to confirm. ' +
    'It returns the real total from the menu - never work one out yourself, and never guess at a price. ' +
    'If it comes back with problems, ask the customer about them rather than trying to solve them yourself.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      lines: orderLinesParameter,
      fulfilmentMethod: fulfilmentParameter,
      deliveryLatitude: { type: Type.NUMBER, description: 'From a location the customer shared. Never typed in from an address.' },
      deliveryLongitude: { type: Type.NUMBER, description: 'From a location the customer shared. Never typed in from an address.' },
    },
    required: ['lines', 'fulfilmentMethod'],
  },
};

export const confirmFoodOrderFunctionDeclaration: FunctionDeclaration = {
  name: CONFIRM_FOOD_ORDER_TOOL_NAME,
  description:
    'Places the order. Only call this after the customer has been told the total and has clearly agreed to it - ' +
    'never on your own initiative, and never to "check" anything, because this puts a real ticket in front of a ' +
    'real kitchen. It returns the order number and, when the business takes payment before cooking, the exact ' +
    'wording to send the customer about paying. Pass that wording on as it is written.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      lines: orderLinesParameter,
      fulfilmentMethod: fulfilmentParameter,
      deliveryLatitude: { type: Type.NUMBER, description: 'From a location the customer shared.' },
      deliveryLongitude: { type: Type.NUMBER, description: 'From a location the customer shared.' },
      deliveryNotes: { type: Type.STRING, description: 'Directions the driver needs, in the customer\'s own words.' },
      tableLabel: { type: Type.STRING, description: 'Which table, for an order eaten in.' },
      allergenNotes: {
        type: Type.STRING,
        description:
          'Any allergy or intolerance the customer mentioned, in their own words. Pass it through exactly - it is ' +
          'shown to the kitchen as a warning, and softening or summarising it could hurt somebody.',
      },
      kitchenNotes: { type: Type.STRING, description: 'Anything else the kitchen should know about the order as a whole.' },
    },
    required: ['lines', 'fulfilmentMethod'],
  },
};

export interface FoodOrderToolLine {
  item?: string;
  quantity?: number;
  modifiers?: { name?: string; action?: string }[];
  notes?: string;
}

export interface QuoteFoodOrderToolArgs {
  lines?: FoodOrderToolLine[];
  fulfilmentMethod?: string;
  deliveryLatitude?: number;
  deliveryLongitude?: number;
}

export interface ConfirmFoodOrderToolArgs extends QuoteFoodOrderToolArgs {
  deliveryNotes?: string;
  tableLabel?: string;
  allergenNotes?: string;
  kitchenNotes?: string;
}
