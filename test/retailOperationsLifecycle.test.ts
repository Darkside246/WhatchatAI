import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { RetailOperationsRepository } from '../src/repositories/retailOperationsRepository.js';
import { createTestBusiness } from './helpers.js';

/**
 * The first real lifecycle mutations retail_orders/retail_products ever
 * have - same class of coverage as propertyOperationsLifecycle.test.ts's
 * incident/work-order lifecycle tests.
 */
describe('RetailOperationsRepository - order/product lifecycle (real Postgres)', () => {
  let businessId: string;
  let repo: RetailOperationsRepository;

  beforeEach(async () => {
    businessId = await createTestBusiness();
    repo = new RetailOperationsRepository(pool);
  });

  describe('updateOrderStatus', () => {
    it('transitions status and stamps fulfilled_at exactly once for FULFILLED', async () => {
      const order = await repo.createOrder({
        id: randomUUID(), businessId, sourceChannel: 'WEB',
        items: [{ productId: randomUUID(), name: 'Blue T-Shirt', quantity: 2, unitPriceCents: 1999 }],
        totalCents: 3998,
      });
      expect(order.status).toBe('PENDING_APPROVAL');
      expect(order.fulfilledAt).toBeNull();

      const fulfilled = await repo.updateOrderStatus(businessId, order.id, 'FULFILLED');
      expect(fulfilled?.status).toBe('FULFILLED');
      expect(fulfilled?.fulfilledAt).not.toBeNull();

      const firstFulfilledAt = fulfilled!.fulfilledAt;
      await new Promise((r) => setTimeout(r, 5));
      const fulfilledAgain = await repo.updateOrderStatus(businessId, order.id, 'FULFILLED');
      expect(fulfilledAgain?.fulfilledAt).toEqual(firstFulfilledAt);
    });

    it('never stamps fulfilled_at for a non-terminal status', async () => {
      const order = await repo.createOrder({ id: randomUUID(), businessId, sourceChannel: 'WEB', items: [], totalCents: 0 });
      const approved = await repo.updateOrderStatus(businessId, order.id, 'APPROVED');
      expect(approved?.status).toBe('APPROVED');
      expect(approved?.fulfilledAt).toBeNull();
    });

    it('returns null for a cross-tenant or nonexistent order, never updating it', async () => {
      const order = await repo.createOrder({ id: randomUUID(), businessId, sourceChannel: 'WEB', items: [], totalCents: 0 });
      const otherBusinessId = await createTestBusiness('Other Business');

      const result = await repo.updateOrderStatus(otherBusinessId, order.id, 'FULFILLED');
      expect(result).toBeNull();

      const untouched = await repo.getOrder(businessId, order.id);
      expect(untouched?.status).toBe('PENDING_APPROVAL');
    });

    it('round-trips the items JSONB array correctly', async () => {
      const items = [
        { productId: randomUUID(), name: 'Blue T-Shirt', quantity: 2, unitPriceCents: 1999 },
        { productId: randomUUID(), name: 'Red Hoodie', quantity: 1, unitPriceCents: 4500 },
      ];
      const order = await repo.createOrder({ id: randomUUID(), businessId, sourceChannel: 'WHATSAPP', items, totalCents: 8498 });
      const fetched = await repo.getOrder(businessId, order.id);
      expect(fetched?.items).toEqual(items);
    });
  });

  describe('updateProductStock', () => {
    it('decrements a stock-tracked product and never goes negative', async () => {
      const product = await repo.createProduct({ id: randomUUID(), businessId, name: 'Blue T-Shirt', stockQuantity: 5 });
      const decremented = await repo.updateProductStock(businessId, product.id, -3);
      expect(decremented?.stockQuantity).toBe(2);

      const flooredAtZero = await repo.updateProductStock(businessId, product.id, -100);
      expect(flooredAtZero?.stockQuantity).toBe(0);
    });

    it('leaves a non-stock-tracked product untouched', async () => {
      const product = await repo.createProduct({ id: randomUUID(), businessId, name: 'Custom Order Item' });
      expect(product.stockQuantity).toBeNull();
      const result = await repo.updateProductStock(businessId, product.id, -1);
      expect(result).toBeNull();
      const fetched = await repo.getProduct(businessId, product.id);
      expect(fetched?.stockQuantity).toBeNull();
    });
  });

  describe('findProductsByNameForBusiness', () => {
    it('matches case-insensitively on a partial name', async () => {
      await repo.createProduct({ id: randomUUID(), businessId, name: 'Blue Cotton T-Shirt' });
      const matches = await repo.findProductsByNameForBusiness(businessId, 'blue');
      expect(matches).toHaveLength(1);
      expect(matches[0]?.name).toBe('Blue Cotton T-Shirt');
    });

    it('never returns another tenant\'s products', async () => {
      const otherBusinessId = await createTestBusiness('Other Business');
      await repo.createProduct({ id: randomUUID(), businessId: otherBusinessId, name: 'Blue Cotton T-Shirt' });
      const matches = await repo.findProductsByNameForBusiness(businessId, 'blue');
      expect(matches).toHaveLength(0);
    });
  });
});
