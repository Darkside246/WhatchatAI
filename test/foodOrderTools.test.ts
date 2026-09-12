import { describe, expect, it } from 'vitest';
import {
  CONFIRM_FOOD_ORDER_TOOL_NAME,
  LIST_MENU_TOOL_NAME,
  QUOTE_FOOD_ORDER_TOOL_NAME,
  confirmFoodOrderFunctionDeclaration,
  listMenuFunctionDeclaration,
  quoteFoodOrderFunctionDeclaration,
} from '../src/services/food/foodOrderTools.js';
import { getToolPolicy } from '../src/services/ai/aiToolPolicy.js';

/**
 * The shape of these tools IS the safety model, so it is asserted rather
 * than trusted. A price field appearing here later would quietly undo the
 * whole deterministic-pricing design.
 */
describe('what the agent may do with a food order', () => {
  const declarations = [listMenuFunctionDeclaration, quoteFoodOrderFunctionDeclaration, confirmFoodOrderFunctionDeclaration];

  it('offers no way to supply a price, total, SKU or availability', () => {
    const forbidden = ['price', 'unitprice', 'total', 'subtotal', 'amount', 'cost', 'cents', 'sku', 'available', 'fee', 'discount'];

    for (const declaration of declarations) {
      const json = JSON.stringify(declaration.parameters ?? {}).toLowerCase();
      for (const field of forbidden) {
        // Checked as a property NAME, so a description mentioning "price"
        // in prose is fine - what must not exist is somewhere to put one.
        expect(json).not.toContain(`"${field}"`);
      }
    }
  });

  it('registers every tool with an explicit risk tier', () => {
    for (const name of [LIST_MENU_TOOL_NAME, QUOTE_FOOD_ORDER_TOOL_NAME, CONFIRM_FOOD_ORDER_TOOL_NAME]) {
      expect(getToolPolicy(name)).toBeTruthy();
    }
  });

  /**
   * Quoting writes nothing, and a customer changing their mind five times
   * must not need five approvals.
   */
  it('lets the agent price an order freely', () => {
    expect(getToolPolicy(LIST_MENU_TOOL_NAME)?.risk).toBe('READ');
    expect(getToolPolicy(QUOTE_FOOD_ORDER_TOOL_NAME)?.risk).toBe('READ');
  });

  /**
   * Placing one puts a real ticket in front of a real kitchen, so it sits
   * at the same tier as booking a meeting - which is what makes the
   * existing autonomy ladder govern it with no special handling.
   */
  it('treats placing one as a real commitment', () => {
    expect(getToolPolicy(CONFIRM_FOOD_ORDER_TOOL_NAME)?.risk).toBe('SEND');
  });

  it('tells the agent to pass the payment wording through unchanged', () => {
    expect(confirmFoodOrderFunctionDeclaration.description).toContain('Pass that wording on as it is written');
  });

  /** An agent that cannot see a sold-out item cannot tell a customer it is sold out. */
  it('tells the agent never to invent or over-promise an item', () => {
    // The extras are named alongside the item on purpose: an agent that
    // may not invent a burger but may invent bacon on it has the same
    // problem in a smaller place.
    expect(listMenuFunctionDeclaration.description).toContain('Never quote a price, an item or an extra that is not in this list');
    expect(listMenuFunctionDeclaration.description).toContain('never tell a customer something is available when this says it is not');
  });

  it('tells the agent not to place an order the customer has not agreed to', () => {
    expect(confirmFoodOrderFunctionDeclaration.description).toContain('never on your own initiative');
  });
});
