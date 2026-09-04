import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { paypalProvider } from '../src/services/billing/providers/paypalProvider.js';

/** Mocks fetch directly, matching zoomMeetingOAuthService.test.ts's own convention. */
const fetchMock = vi.fn<typeof fetch>();
vi.stubGlobal('fetch', fetchMock);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('paypalProvider', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    process.env['PAYPAL_CLIENT_ID'] = 'test-client-id';
    process.env['PAYPAL_CLIENT_SECRET'] = 'test-client-secret';
    process.env['PAYPAL_WEBHOOK_ID'] = 'test-webhook-id';
    delete process.env['PAYPAL_ENV'];
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('buildCheckoutInstructions', () => {
    it('gets an OAuth token, creates a real order against the sandbox host by default, and returns the approval link', async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ access_token: 'test-access-token' }))
        .mockResolvedValueOnce(
          jsonResponse({ id: 'ORDER-123', links: [{ rel: 'approve', href: 'https://www.sandbox.paypal.com/checkoutnow?token=ORDER-123' }] }),
        );

      const result = await paypalProvider.buildCheckoutInstructions('SAAS-ABC123', { amountMinor: 4599, currency: 'usd' });

      expect(result).toMatchObject({ provider: 'paypal', orderId: 'ORDER-123', approvalUrl: 'https://www.sandbox.paypal.com/checkoutnow?token=ORDER-123', reference: 'SAAS-ABC123' });

      const [tokenUrl] = fetchMock.mock.calls[0]!;
      expect(String(tokenUrl)).toBe('https://api-m.sandbox.paypal.com/v1/oauth2/token');
      const [orderUrl, orderInit] = fetchMock.mock.calls[1]!;
      expect(String(orderUrl)).toBe('https://api-m.sandbox.paypal.com/v2/checkout/orders');
      const body = JSON.parse(String((orderInit as RequestInit).body));
      expect(body.purchase_units[0]).toMatchObject({ custom_id: 'SAAS-ABC123', amount: { currency_code: 'USD', value: '45.99' } });
    });

    it('uses the live host when PAYPAL_ENV=live', async () => {
      process.env['PAYPAL_ENV'] = 'live';
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ access_token: 'test-access-token' }))
        .mockResolvedValueOnce(jsonResponse({ id: 'ORDER-456', links: [] }));

      await paypalProvider.buildCheckoutInstructions('SAAS-XYZ789', { amountMinor: 1000, currency: 'BBD' });

      expect(String(fetchMock.mock.calls[0]![0])).toBe('https://api-m.paypal.com/v1/oauth2/token');
    });

    it('throws when PayPal credentials are not configured', async () => {
      delete process.env['PAYPAL_CLIENT_ID'];
      await expect(paypalProvider.buildCheckoutInstructions('SAAS-NOPE', { amountMinor: 100, currency: 'USD' })).rejects.toThrow(/not configured/i);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('verifyEvent', () => {
    const validHeaders = {
      'paypal-transmission-id': 'txn-1',
      'paypal-transmission-time': '2026-01-01T00:00:00Z',
      'paypal-transmission-sig': 'sig',
      'paypal-cert-url': 'https://api.paypal.com/cert',
      'paypal-auth-algo': 'SHA256withRSA',
    };
    const captureBody = {
      id: 'WH-EVT-1',
      event_type: 'PAYMENT.CAPTURE.COMPLETED',
      resource: { custom_id: 'SAAS-ABC123', amount: { currency_code: 'USD', value: '45.99' } },
    };

    it('verifies a genuine PAYMENT.CAPTURE.COMPLETED event and extracts the real checkout reference/amount', async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ access_token: 'test-access-token' }))
        .mockResolvedValueOnce(jsonResponse({ verification_status: 'SUCCESS' }));

      const result = await paypalProvider.verifyEvent({ body: captureBody, headers: validHeaders, secret: 'test-webhook-id' });

      expect(result).toEqual({ outcome: 'verified', checkoutReference: 'SAAS-ABC123', amountMinor: 4599, currency: 'USD', providerEventId: 'WH-EVT-1' });
    });

    it('rejects when PayPal reports the signature as not verified - never trusts a forged webhook', async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ access_token: 'test-access-token' }))
        .mockResolvedValueOnce(jsonResponse({ verification_status: 'FAILURE' }));

      const result = await paypalProvider.verifyEvent({ body: captureBody, headers: validHeaders, secret: 'test-webhook-id' });
      expect(result).toEqual({ outcome: 'rejected', reason: 'INVALID_PAYPAL_SIGNATURE' });
    });

    it('rejects when required PayPal transmission headers are missing, before ever calling PayPal', async () => {
      const result = await paypalProvider.verifyEvent({ body: captureBody, headers: {}, secret: 'test-webhook-id' });
      expect(result).toEqual({ outcome: 'rejected', reason: 'MISSING_PAYPAL_WEBHOOK_HEADERS' });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('rejects when no webhook id is configured (ctx.secret empty)', async () => {
      const result = await paypalProvider.verifyEvent({ body: captureBody, headers: validHeaders, secret: '' });
      expect(result).toEqual({ outcome: 'rejected', reason: 'PAYPAL_WEBHOOK_ID_NOT_CONFIGURED' });
    });

    it('ignores (not rejects) a genuine, verified event of a type it does not act on, e.g. ORDER.APPROVED', async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ access_token: 'test-access-token' }))
        .mockResolvedValueOnce(jsonResponse({ verification_status: 'SUCCESS' }));

      const result = await paypalProvider.verifyEvent({
        body: { id: 'WH-EVT-2', event_type: 'CHECKOUT.ORDER.APPROVED', resource: { id: 'ORDER-1' } },
        headers: validHeaders,
        secret: 'test-webhook-id',
      });
      expect(result).toEqual({ outcome: 'ignored', reason: 'UNHANDLED_PAYPAL_EVENT_TYPE:CHECKOUT.ORDER.APPROVED' });
    });
  });
});
