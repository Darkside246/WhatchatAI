import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { RetailCreateOrderExecutor, RETAIL_CREATE_ORDER_ACTION_TYPE } from '../src/services/retail/retailCreateOrderExecutor.js';
import { RetailOperationsRepository } from '../src/repositories/retailOperationsRepository.js';
import { createTestBusiness } from './helpers.js';
import type { ActionRequest } from '../src/domain/platform/contracts.js';

function fakeAction(businessId: string, items: Array<{ productNameOrRef: string; quantity: number }>, overrides: Partial<ActionRequest['payload']> = {}): ActionRequest {
  return {
    id: 'action-1',
    tenantId: businessId,
    type: RETAIL_CREATE_ORDER_ACTION_TYPE,
    payload: { items, summary: 'Order summary', messageText: 'I want to order this', confidence: 0.9, ...overrides },
    requestedBy: { kind: 'AGENT', id: 'retail-order-triage' },
    riskLevel: 'LOW',
    approval: { required: true, status: 'APPROVED' },
    status: 'READY',
    idempotencyKey: 'idem-1',
    correlationId: 'corr-1',
    createdAt: new Date().toISOString(),
  };
}

describe('RetailCreateOrderExecutor (real Postgres)', () => {
  let businessId: string;
  const executor = new RetailCreateOrderExecutor();
  const retailRepo = new RetailOperationsRepository(pool);

  beforeEach(async () => {
    businessId = await createTestBusiness();
  });

  it('resolves free-text item references to real catalog products and creates the order', async () => {
    const product = await retailRepo.createProduct({ id: randomUUID(), businessId, name: 'Blue T-Shirt', priceCents: 1999, stockQuantity: 10 });

    const action = fakeAction(businessId, [{ productNameOrRef: 'Blue T-Shirt', quantity: 2 }]);
    const result = await executor.execute(action, { tenantId: businessId, actorId: 'user-1' });

    expect(result.status).toBe('SUCCEEDED');
    const { orderId, totalCents } = result.result as { orderId: string; totalCents: number };
    // retail_orders.total_cents is BIGINT - node-postgres returns it as a
    // string by default (same quirk documented in
    // maintenanceWorkOrderExecutor.test.ts for property_incidents.confidence).
    expect(Number(totalCents)).toBe(3998);

    const order = await retailRepo.getOrder(businessId, orderId);
    expect(order?.status).toBe('APPROVED');
    expect(order?.items).toEqual([{ productId: product.id, name: 'Blue T-Shirt', quantity: 2, unitPriceCents: 1999 }]);
  });

  it('decrements stock for each resolved item', async () => {
    const product = await retailRepo.createProduct({ id: randomUUID(), businessId, name: 'Blue T-Shirt', priceCents: 1999, stockQuantity: 10 });
    const action = fakeAction(businessId, [{ productNameOrRef: 'Blue T-Shirt', quantity: 3 }]);
    await executor.execute(action, { tenantId: businessId, actorId: 'user-1' });

    const updated = await retailRepo.getProduct(businessId, product.id);
    expect(updated?.stockQuantity).toBe(7);
  });

  it('drops an item that cannot be matched to a real product rather than inventing one', async () => {
    await retailRepo.createProduct({ id: randomUUID(), businessId, name: 'Blue T-Shirt', priceCents: 1999 });
    const action = fakeAction(businessId, [
      { productNameOrRef: 'Blue T-Shirt', quantity: 1 },
      { productNameOrRef: 'Nonexistent Product', quantity: 5 },
    ]);
    const result = await executor.execute(action, { tenantId: businessId, actorId: 'user-1' });
    expect(result.status).toBe('SUCCEEDED');
    const { orderId } = result.result as { orderId: string };
    const order = await retailRepo.getOrder(businessId, orderId);
    expect(order?.items).toHaveLength(1);
    expect(order?.items[0]?.name).toBe('Blue T-Shirt');
  });

  it('fails cleanly (no partial order) when no item can be matched to a real product', async () => {
    const action = fakeAction(businessId, [{ productNameOrRef: 'Nonexistent Product', quantity: 1 }]);
    const result = await executor.execute(action, { tenantId: businessId, actorId: 'user-1' });
    expect(result.status).toBe('FAILED');
    const orders = await retailRepo.listOrders(businessId);
    expect(orders).toHaveLength(0);
  });

  it('fails cleanly when the action payload has no items', async () => {
    const action = fakeAction(businessId, []);
    const result = await executor.execute(action, { tenantId: businessId, actorId: 'user-1' });
    expect(result.status).toBe('FAILED');
    expect(result.error).toContain('items');
  });
});
