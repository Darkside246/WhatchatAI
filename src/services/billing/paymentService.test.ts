import { describe, expect, it } from 'vitest';
import { buildBiMPaySignature, generateCheckoutReference } from './paymentService.js';

describe('payment billing primitives', () => {
  it('generates short uppercase checkout references', () => {
    const reference = generateCheckoutReference();
    expect(reference).toMatch(/^SAAS-[0-9A-F]{6}$/);
  });

  it('creates a deterministic BiMPay bridge signature for the canonical event', () => {
    const input = {
      provider: 'BIMPAY' as const,
      checkoutReference: 'saas-a1b2c3',
      amountMinor: 12900,
      currency: 'bbd',
      providerEventId: 'bank-event-001',
    };
    const first = buildBiMPaySignature(input, 'test-secret');
    const second = buildBiMPaySignature({ ...input, checkoutReference: 'SAAS-A1B2C3', currency: 'BBD' }, 'test-secret');
    expect(first).toHaveLength(64);
    expect(first).toBe(second);
  });

  it('changes the signature when the amount changes', () => {
    const base = { provider: 'BIMPAY' as const, checkoutReference: 'SAAS-A1B2C3', amountMinor: 12900, currency: 'BBD', providerEventId: 'bank-event-001' };
    expect(buildBiMPaySignature(base, 'test-secret')).not.toBe(buildBiMPaySignature({ ...base, amountMinor: 12901 }, 'test-secret'));
  });
});
