import { z } from 'zod';

export const PaymentProviderSchema = z.enum(['BIMPAY', 'BANK_TRANSFER', 'OTHER']);
export type PaymentProvider = z.infer<typeof PaymentProviderSchema>;

export const PaymentStatusSchema = z.enum(['PENDING', 'RECEIVED', 'VERIFIED', 'REJECTED', 'EXPIRED', 'REFUNDED']);
export type PaymentStatus = z.infer<typeof PaymentStatusSchema>;

export const SubscriptionStatusSchema = z.enum(['PENDING_PAYMENT', 'ACTIVE', 'PAST_DUE', 'CANCELLED', 'EXPIRED']);
export type SubscriptionStatus = z.infer<typeof SubscriptionStatusSchema>;

export interface Checkout {
  paymentAttemptId: string;
  subscriptionId: string;
  checkoutReference: string;
  provider: PaymentProvider;
  currency: string;
  amountMinor: number;
  status: PaymentStatus;
}

export interface PaymentVerificationInput {
  provider: PaymentProvider;
  checkoutReference: string;
  amountMinor: number;
  currency: string;
  providerEventId: string;
  receivedAt?: Date;
}
