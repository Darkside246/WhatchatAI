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
      expect(offer).toEqual({ planKey: 'starter', tokens: 250_000, priceCents: 219, currency: 'USD' });
    });

    it('returns the real growth pack for a business on the growth plan', async () => {
      await createTestSubscription(businessId, 'growth');
      const offer = await getTopupOffer(businessId);
      expect(offer).toEqual({ planKey: 'growth', tokens: 1_000_000, priceCents: 849, currency: 'USD' });
    });

    it('returns null for enterprise - unlimited plans never need a top-up', async () => {
      await createTestSubscription(businessId, 'enterprise');
      expect(await getTopupOffer(businessId)).toBeNull();
    });

    it('returns null for a business with no live subscription at all', async () => {
      expect(await getTopupOffer(businessId)).toBeNull();
    });
  });

  /**
   * The prices above are real business values, so they are asserted
   * literally rather than derived from the catalogue - a test that read the
   * catalogue to check the catalogue would pass on any figure at all.
   *
   * This block asserts the INVARIANT behind those figures instead: every
   * pack must clear the 60% margin the business set. That is what catches a
   * future reprice that silently undershoots, which a hardcoded equality
   * check cannot do (it just fails, saying nothing about why).
   *
   * Margin, not markup: margin = (price - cost) / price, so 60% means
   * price = cost / 0.4, i.e. cost x 2.5 - NOT cost x 1.6, which is a 60%
   * markup and only a 37.5% margin.
   */
  describe('catalogue margin', () => {
    // 0.75 * $1.50 + 0.25 * $9.00 per 1M tokens - the same blended Gemini
    // 3.5 Flash cost the catalogue itself is priced against.
    const COST_PER_MILLION_USD = 3.375;
    const TARGET_MARGIN = 0.6;

    it('every token pack clears the 60% margin target on token cost', () => {
      for (const [planKey, pack] of Object.entries(TOPUP_CATALOG)) {
        const costUsd = (pack.tokens / 1_000_000) * COST_PER_MILLION_USD;
        const priceUsd = pack.priceCents / 100;
        const margin = (priceUsd - costUsd) / priceUsd;
        expect(margin, `${planKey} pack margin`).toBeGreaterThanOrEqual(TARGET_MARGIN);
      }
    });

    it('no pack is priced at a mere 60% MARKUP, which would be a 37.5% margin', () => {
      for (const [planKey, pack] of Object.entries(TOPUP_CATALOG)) {
        const costUsd = (pack.tokens / 1_000_000) * COST_PER_MILLION_USD;
        const priceUsd = pack.priceCents / 100;
        expect(priceUsd, `${planKey} pack price`).toBeGreaterThan(costUsd * 1.6);
      }
    });
  });

  describe('createTopupCheckout', () => {
    it('creates a real PENDING purchase and returns real BiMPay checkout instructions', async () => {
      await createTestSubscription(businessId, 'starter');
      const { purchase, instructions } = await createTopupCheckout(businessId, 'bimpay');
      expect(purchase.status).toBe('PENDING');
      expect(purchase.tokensPurchased).toBe(250_000);
      expect(purchase.amountMinor).toBe(219);
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
