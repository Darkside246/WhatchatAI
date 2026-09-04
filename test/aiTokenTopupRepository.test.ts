import { beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { AiTokenTopupRepository } from '../src/repositories/aiTokenTopupRepository.js';
import { createTestBusiness, resetDatabase } from './helpers.js';

/**
 * Section 34-40's real budget-override flow (migration 980) - a self-serve
 * token top-up purchase, separate from payment_attempts (see the
 * migration's own doc comment for why).
 */
describe('AiTokenTopupRepository (real Postgres - migration 980)', () => {
  const repo = new AiTokenTopupRepository(pool);
  let businessId: string;

  beforeEach(async () => {
    await resetDatabase();
    businessId = await createTestBusiness();
  });

  it('creates a real PENDING purchase and finds it by checkout reference', async () => {
    const created = await repo.create({ businessId, provider: 'BIMPAY', checkoutReference: 'TOPUP-ABC123', tokensPurchased: 250_000, amountMinor: 199, currency: 'USD' });
    expect(created.status).toBe('PENDING');
    expect(created.verifiedAt).toBeNull();

    const found = await repo.findByCheckoutReference('TOPUP-ABC123');
    expect(found?.id).toBe(created.id);
    expect(found?.tokensPurchased).toBe(250_000);
  });

  it('markVerified moves a real PENDING purchase to VERIFIED with a real timestamp', async () => {
    await repo.create({ businessId, provider: 'PAYPAL', checkoutReference: 'TOPUP-XYZ789', tokensPurchased: 1_000_000, amountMinor: 799, currency: 'USD' });
    const { purchase, alreadyVerified } = await repo.markVerified('TOPUP-XYZ789', 'WH-EVT-1');
    expect(alreadyVerified).toBe(false);
    expect(purchase.status).toBe('VERIFIED');
    expect(purchase.providerEventId).toBe('WH-EVT-1');
    expect(purchase.verifiedAt).not.toBeNull();
  });

  it('markVerified is idempotent - a repeat call for an already-verified purchase never double-processes', async () => {
    await repo.create({ businessId, provider: 'PAYPAL', checkoutReference: 'TOPUP-DUP001', tokensPurchased: 1_000_000, amountMinor: 799, currency: 'USD' });
    await repo.markVerified('TOPUP-DUP001', 'WH-EVT-1');
    const second = await repo.markVerified('TOPUP-DUP001', 'WH-EVT-1');
    expect(second.alreadyVerified).toBe(true);
  });

  it('throws for an unknown checkout reference rather than silently no-op-ing', async () => {
    await expect(repo.markVerified('TOPUP-NOPE', 'WH-EVT-1')).rejects.toThrow(/not found/i);
  });

  it('getVerifiedTokensThisMonthForBusiness sums only real VERIFIED purchases, never PENDING or REJECTED ones', async () => {
    await repo.create({ businessId, provider: 'BIMPAY', checkoutReference: 'TOPUP-V1', tokensPurchased: 250_000, amountMinor: 199, currency: 'USD' });
    await repo.markVerified('TOPUP-V1', 'EVT-1');
    await repo.create({ businessId, provider: 'BIMPAY', checkoutReference: 'TOPUP-PENDING', tokensPurchased: 250_000, amountMinor: 199, currency: 'USD' });

    const total = await repo.getVerifiedTokensThisMonthForBusiness(businessId);
    expect(total).toBe(250_000);
  });

  it('excludes a verified top-up from a prior calendar month - real UTC-month boundary, not a rolling window', async () => {
    await repo.create({ businessId, provider: 'BIMPAY', checkoutReference: 'TOPUP-OLD', tokensPurchased: 250_000, amountMinor: 199, currency: 'USD' });
    await repo.markVerified('TOPUP-OLD', 'EVT-OLD');
    await pool.query(`UPDATE ai_token_topup_purchases SET verified_at = now() - interval '45 days' WHERE checkout_reference = 'TOPUP-OLD'`);

    const total = await repo.getVerifiedTokensThisMonthForBusiness(businessId);
    expect(total).toBe(0);
  });

  it('never leaks another business\'s top-ups (tenant isolation)', async () => {
    const otherBusinessId = await createTestBusiness('Other Business');
    await repo.create({ businessId: otherBusinessId, provider: 'BIMPAY', checkoutReference: 'TOPUP-OTHER', tokensPurchased: 5_000_000, amountMinor: 3799, currency: 'USD' });
    await repo.markVerified('TOPUP-OTHER', 'EVT-OTHER');

    const total = await repo.getVerifiedTokensThisMonthForBusiness(businessId);
    expect(total).toBe(0);
  });
});
