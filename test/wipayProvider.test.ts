import { describe, expect, it } from 'vitest';
import { wipayProvider } from '../src/services/billing/providers/wipayProvider.js';

/**
 * WiPay's real webhook payload shape and signature scheme are not known
 * (see wipayProvider.ts's own doc comment) - this proves the stub is
 * deliberately inert rather than silently permissive, since a forged
 * webhook accepted by mistake would fraudulently activate a real
 * subscription.
 */
describe('wipayProvider (deliberate stub, not yet integrated)', () => {
  it('never verifies any event, regardless of headers or body shape', async () => {
    const result = await wipayProvider.verifyEvent({ body: { anything: 'at all' }, headers: {}, secret: 'even-a-real-looking-secret' });
    expect(result).toEqual({ outcome: 'rejected', reason: 'WIPAY_INTEGRATION_NOT_YET_IMPLEMENTED' });
  });

  it('refuses to build checkout instructions rather than pretending to support real checkout', () => {
    expect(() => wipayProvider.buildCheckoutInstructions('SAAS-ABC', { amountMinor: 100, currency: 'BBD' })).toThrow(/not yet implemented/i);
  });
});
