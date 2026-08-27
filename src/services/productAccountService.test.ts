import { describe, expect, it } from 'vitest';
import { ProductAccountSchema, ProductKeySchema, ProductAccountStatusSchema } from '../domain/platform/productAccounts.js';

describe('product account foundation', () => {
  it('supports the product catalogue domains', () => {
    expect(ProductKeySchema.options).toEqual(['property', 'food', 'commerce', 'scheduling', 'support']);
  });

  it('keeps account status explicit and server-owned', () => {
    expect(ProductAccountStatusSchema.options).toEqual(['PROVISIONING', 'ACTIVE', 'RESTRICTED', 'SUSPENDED', 'CLOSED']);
    expect(() => ProductAccountSchema.parse({
      id: 'not-a-uuid', businessId: 'not-a-uuid', productId: 'not-a-uuid', productKey: 'food',
      ownerUserId: 'not-a-uuid', displayName: 'Food', status: 'ACTIVE', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    })).toThrow();
  });
});
