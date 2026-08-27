import { describe, expect, it } from 'vitest';
import type { CommunicationEvent } from '../../domain/platform/contracts.js';
import { runFoodOrderingTurn } from './foodOrderingAgentService.js';
import { createInitialFoodOrder, type FoodMenuItem } from './foodOrderingPolicy.js';

const menu: FoodMenuItem[] = [
  { id: 'chicken', name: 'Chicken Roti', price: 12, available: true, aliases: ['roti'], options: {} },
  { id: 'pie', name: 'Macaroni Pie', price: 6, available: true, aliases: ['mac pie'], options: {} },
];

function event(text: string): CommunicationEvent {
  return {
    id: crypto.randomUUID(), tenantId: 'tenant-1', channel: 'WHATSAPP', conversationId: 'conv-1',
    sender: { address: '+12465550000', displayName: 'Customer', role: 'GUEST' },
    message: { type: 'TEXT', text }, occurredAt: new Date().toISOString(), correlationId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID(),
  };
}

describe('food ordering agent', () => {
  it('handles a natural multi-item order and asks only for the next needed detail', () => {
    const first = runFoodOrderingTurn({ event: event('2 chicken roti and a mac pie'), context: { menu } });
    expect(first.state.lines).toHaveLength(2);
    expect(first.reply).toContain('pickup or have it delivered');

    const second = runFoodOrderingTurn({ event: event('pickup'), state: first.state, context: { menu } });
    expect(second.reply).toContain('Does that look right?');
    expect(second.state.status).toBe('READY_TO_CONFIRM');
  });

  it('collects a delivery address before confirmation', () => {
    const base = createInitialFoodOrder('tenant-1', 'conv-1', '+12465550000');
    const ordered = runFoodOrderingTurn({ event: event('one chicken roti'), state: base, context: { menu, deliveryFee: 5 } });
    const delivery = runFoodOrderingTurn({ event: event('delivery'), state: ordered.state, context: { menu, deliveryFee: 5 } });
    expect(delivery.state.status).toBe('NEEDS_CUSTOMER_DETAILS');
    const address = runFoodOrderingTurn({ event: event('12 Broad Street'), state: delivery.state, context: { menu, deliveryFee: 5 } });
    expect(address.state.customerAddress).toBe('12 Broad Street');
    expect(address.reply).toContain('17.00');
  });

  it('allows a customer to cancel without creating an order', () => {
    const base = createInitialFoodOrder('tenant-1', 'conv-1');
    const ordered = runFoodOrderingTurn({ event: event('one chicken roti'), state: base, context: { menu } });
    const cancelled = runFoodOrderingTurn({ event: event('never mind'), state: ordered.state, context: { menu } });
    expect(cancelled.state.status).toBe('CANCELLED');
    expect(cancelled.action).toBe('CANCEL_ORDER');
  });
});
