import { beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import {
  getTopupOffer,
  createTopupCheckout,
  verifyTopupPayment,
  NoTopupOfferError,
  TopupVerificationError,
  TOPUP_CATALOG,
} from '../src/services/billing/aiTokenTopupService.js';
import { AiTokenTopupRepository } from '../src/repositories/aiTokenTopupRepository.js';
import { NotificationRepository } from '../src/repositories/notificationRepository.js';
import { createTestBusiness, createTestSubscription, createTestUser, resetDatabase } from './helpers.js';
import type { VerifyEventResult } from '../src/services/billing/providers/types.js';

describe('aiTokenTopupService (real Postgres)', () => {
  const topupRepository = new AiTokenTopupRepository(pool);
  const notifications = new NotificationRepository(pool);
  let businessId: string;

  beforeEach(async () => {
    await resetDatabase();
    businessId = await createTestBusiness();
  });

  describe('getTopupOffer', () => {
    it('returns the real starter pack for a business on the starter plan', async () => {
      await createTestSubscription(businessId, 'starter');
      const offer = await getTopupOffer(businessId);
      expect(offer).toEqual({ planKey: 'starter', tokens: 250_000, priceCents: 199, currency: 'USD' });
    });

    it('returns the real growth pack for a business on the growth plan', async () => {
      await createTestSubscription(businessId, 'growth');
      const offer = await getTopupOffer(businessId);
      expect(offer).toEqual({ planKey: 'growth', tokens: 1_000_000, priceCents: 799, currency: 'USD' });
    });

    it('returns null for enterprise - unlimited plans never need a top-up', async () => {
      await createTestSubscription(businessId, 'enterprise');
      expect(await getTopupOffer(businessId)).toBeNull();
    });

    it('returns null for a business with no live subscription at all', async () => {
      expect(await getTopupOffer(businessId)).toBeNull();
    });
  });

  describe('createTopupCheckout', () => {
    it('creates a real PENDING purchase and returns real BiMPay checkout instructions', async () => {
      await createTestSubscription(businessId, 'starter');
      const { purchase, instructions } = await createTopupCheckout(businessId, 'bimpay');
      expect(purchase.status).toBe('PENDING');
      expect(purchase.tokensPurchased).toBe(250_000);
      expect(purchase.amountMinor).toBe(199);
      expect(instructions).toMatchObject({ reference: purchase.checkoutReference, memoRequired: true });
    });

    it('throws NoTopupOfferError for an enterprise business rather than creating a real charge', async () => {
      await createTestSubscription(businessId, 'enterprise');
      await expect(createTopupCheckout(businessId, 'bimpay')).rejects.toThrow(NoTopupOfferError);
    });
  });

  describe('verifyTopupPayment', () => {
    async function pendingPurchase(planKey: 'starter' | 'growth' | 'business') {
      await createTestSubscription(businessId, planKey);
      return createTopupCheckout(businessId, 'bimpay');
    }

    it('credits real tokens and sends a real "tokens added" notification on genuine verification', async () => {
      const userId = await createTestUser(businessId);
      const { purchase } = await pendingPurchase('starter');

      const verified: Extract<VerifyEventResult, { outcome: 'verified' }> = {
        outcome: 'verified',
        checkoutReference: purchase.checkoutReference,
        amountMinor: purchase.amountMinor,
        currency: purchase.currency,
        providerEventId: 'EVT-REAL-1',
      };
      await verifyTopupPayment(verified);

      const stored = await topupRepository.findByCheckoutReference(purchase.checkoutReference);
      expect(stored?.status).toBe('VERIFIED');

      const notified = await notifications.listForUser(businessId, userId, 10);
      expect(notified).toHaveLength(1);
      expect(notified[0]).toMatchObject({ type: 'AI_TOKENS_ADDED' });
      expect(notified[0]?.body).toContain('250,000');
    });

    it('rejects a payment whose amount does not match the real checkout - never credits tokens for less than was actually charged', async () => {
      const { purchase } = await pendingPurchase('starter');
      const mismatched: Extract<VerifyEventResult, { outcome: 'verified' }> = {
        outcome: 'verified',
        checkoutReference: purchase.checkoutReference,
        amountMinor: 1,
        currency: purchase.currency,
        providerEventId: 'EVT-BAD-1',
      };
      await expect(verifyTopupPayment(mismatched)).rejects.toThrow(TopupVerificationError);

      const stored = await topupRepository.findByCheckoutReference(purchase.checkoutReference);
      expect(stored?.status).toBe('PENDING');
    });

    it('never double-notifies for the same purchase verified twice (idempotent)', async () => {
      const userId = await createTestUser(businessId);
      const { purchase } = await pendingPurchase('starter');
      const verified: Extract<VerifyEventResult, { outcome: 'verified' }> = {
        outcome: 'verified',
        checkoutReference: purchase.checkoutReference,
        amountMinor: purchase.amountMinor,
        currency: purchase.currency,
        providerEventId: 'EVT-DUP-1',
      };
      await verifyTopupPayment(verified);
      await verifyTopupPayment(verified);

      const notified = await notifications.listForUser(businessId, userId, 10);
      expect(notified).toHaveLength(1);
    });
  });

  it('the catalog only covers the 3 metered tiers - enterprise is deliberately absent', () => {
    expect(Object.keys(TOPUP_CATALOG).sort()).toEqual(['business', 'growth', 'starter']);
  });
});
