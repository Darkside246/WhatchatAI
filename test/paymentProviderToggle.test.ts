import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { PlatformSettingsRepository } from '../src/repositories/platformSettingsRepository.js';
import { isProviderConfigured, isProviderEnabled, isProviderUsable } from '../src/services/billing/paymentProviderStatusService.js';
import { resetDatabase } from './helpers.js';

/**
 * The real gate every checkout/webhook now passes through before a
 * provider is treated as usable (Section 73-74) - configured (real env
 * credentials present) AND not switched off from the live Control Plane
 * toggle (platform_settings, migration 977).
 */
describe('payment provider configured/enabled/usable (Section 73-74)', () => {
  const settings = new PlatformSettingsRepository(pool);
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    await resetDatabase();
    process.env['BIMPAY_BRIDGE_SECRET'] = 'test-bimpay-secret';
    delete process.env['PAYPAL_CLIENT_ID'];
    delete process.env['PAYPAL_CLIENT_SECRET'];
    delete process.env['PAYPAL_WEBHOOK_ID'];
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('bimpay is configured when its secret is present', () => {
    expect(isProviderConfigured('bimpay')).toBe(true);
  });

  it('paypal is not configured until all three of its env vars are present', () => {
    expect(isProviderConfigured('paypal')).toBe(false);
    process.env['PAYPAL_CLIENT_ID'] = 'id';
    process.env['PAYPAL_CLIENT_SECRET'] = 'secret';
    expect(isProviderConfigured('paypal')).toBe(false);
    process.env['PAYPAL_WEBHOOK_ID'] = 'webhook-id';
    expect(isProviderConfigured('paypal')).toBe(true);
  });

  it('wipay is never configured - a deliberate stub, not a missing env var', () => {
    expect(isProviderConfigured('wipay')).toBe(false);
  });

  it('a configured provider defaults to enabled with no explicit platform_settings row', async () => {
    expect(await isProviderEnabled('bimpay')).toBe(true);
  });

  it('a developer can switch a configured provider off live, and isProviderUsable reflects it immediately', async () => {
    expect(await isProviderUsable('bimpay')).toBe(true);
    await settings.set('payment_provider:bimpay', { enabled: false }, null);
    expect(await isProviderEnabled('bimpay')).toBe(false);
    expect(await isProviderUsable('bimpay')).toBe(false);
  });

  it('an unconfigured provider is never usable even if explicitly enabled in platform_settings', async () => {
    await settings.set('payment_provider:paypal', { enabled: true }, null);
    expect(await isProviderUsable('paypal')).toBe(false);
  });
});
