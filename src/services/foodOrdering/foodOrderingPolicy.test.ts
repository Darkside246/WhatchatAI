import { describe, expect, it } from 'vitest';
import {
  addMenuItem,
  calculateOrderTotal,
  createInitialFoodOrder,
  detectCancellation,
  detectFulfilment,
  type FoodMenuItem,
} from './foodOrderingPolicy.js';

const menu: FoodMenuItem[] = [
  { id: 'roti', name: 'Chicken Roti', price: 12, available: true, aliases: ['chicken roti'], options: {} },
  { id: 'pie', name: 'Macaroni Pie', price: 6, available: true, aliases: ['mac pie', 'macaroni'] , options: {} },
  { id: 'fish', name: 'Fish Cutter', price: 10, available: false, aliases: ['fish sandwich'], options: {} },
];

describe('food ordering policy', () => {
  it('understands WhatsApp-style pickup and delivery language', () => {
    expect(detectFulfilment('Can you bring it to me?')).toBe('DELIVERY');
    expect(detectFulfilment('I coming for it')).toBe('PICKUP');
    expect(detectFulfilment('drop it off please')).toBe('DELIVERY');
  });

  it('understands informal menu aliases and quantities', () => {
    const state = createInitialFoodOrder('tenant-1', 'conversation-1');
    const next = addMenuItem(state, menu, '2 chicken roti and a mac pie');
    expect(next.lines).toHaveLength(2);
    expect(next.lines[0]!.quantity).toBe(2);
    expect(next.lines[1]!.name).toBe('Macaroni Pie');
    expect(calculateOrderTotal(next)).toBe(30);
  });

  it('does not add unavailable food', () => {
    const state = createInitialFoodOrder('tenant-1', 'conversation-1');
    expect(addMenuItem(state, menu, 'one fish cutter').lines).toHaveLength(0);
  });

  it('recognises cancellation language', () => {
    expect(detectCancellation('never mind')).toBe(true);
    expect(detectCancellation('cancel it please')).toBe(true);
    expect(detectCancellation('yes, add one more')).toBe(false);
  });
});
