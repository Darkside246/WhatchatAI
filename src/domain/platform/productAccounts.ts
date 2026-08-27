import { z } from 'zod';

export const ProductKeySchema = z.enum(['property', 'food', 'commerce', 'scheduling', 'support']);
export type ProductKey = z.infer<typeof ProductKeySchema>;

export const ProductAccountStatusSchema = z.enum(['PROVISIONING', 'ACTIVE', 'RESTRICTED', 'SUSPENDED', 'CLOSED']);
export type ProductAccountStatus = z.infer<typeof ProductAccountStatusSchema>;

export const ProductAccountSchema = z.object({
  id: z.string().uuid(),
  businessId: z.string().uuid(),
  productId: z.string().uuid(),
  productKey: ProductKeySchema,
  ownerUserId: z.string().uuid().nullable(),
  displayName: z.string().min(1).max(200),
  status: ProductAccountStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ProductAccount = z.infer<typeof ProductAccountSchema>;

export interface ProductEntitlement {
  key: string;
  enabled: boolean;
  limit: number | null;
  source: 'PRODUCT' | 'PLAN' | 'TRIAL' | 'OVERRIDE';
  expiresAt: string | null;
}

export interface ProductAccountAccess {
  account: ProductAccount;
  entitlements: ProductEntitlement[];
  operationalAccess: boolean;
}
