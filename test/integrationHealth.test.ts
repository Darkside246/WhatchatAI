import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { workspaceService } from '../src/services/workspaceService.js';
import { createTestAccount, createTestBusiness, resetDatabase } from './helpers.js';

/**
 * Section 120 (Integration Health Centre): every entry's state must come
 * from something real - server credential presence, a real connection row,
 * a live engine health check - never a guess. Env vars are explicitly
 * stubbed/restored here (matching aiEngineStatus.test.ts's own pattern) so
 * this test's outcome never depends on what happens to be set in this
 * machine's real .env - the same real credentials this codebase honestly
 * reports as absent in production must also read as absent here.
 */
describe('workspaceService.getIntegrationHealth (real, honest status - never a fabricated connected)', () => {
  const ENV_KEYS = [
    'GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET',
    'ZOOM_CLIENT_ID', 'ZOOM_CLIENT_SECRET',
    'OUTLOOK_CLIENT_ID', 'OUTLOOK_CLIENT_SECRET',
    'BIMPAY_BRIDGE_SECRET', 'PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET', 'PAYPAL_WEBHOOK_ID',
  ] as const;
  const original: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};

  let businessId: string;

  beforeEach(async () => {
    for (const key of ENV_KEYS) {
      original[key] = process.env[key];
      delete process.env[key];
    }
    await resetDatabase();
    businessId = await createTestBusiness();
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  });

  it('reports every meetings/email/payments integration as not_configured with none of the real credentials present', async () => {
    const health = await workspaceService.getIntegrationHealth(businessId);

    const byId = Object.fromEntries(health.integrations.map((i) => [i.id, i]));
    expect(byId['google_meet']?.state).toBe('not_configured');
    expect(byId['zoom']?.state).toBe('not_configured');
    expect(byId['email_gmail']?.state).toBe('not_configured');
    expect(byId['email_outlook']?.state).toBe('not_configured');
    expect(byId['payment_bimpay']?.state).toBe('not_configured');
    expect(byId['payment_paypal']?.state).toBe('not_configured');
    expect(byId['payment_wipay']?.state).toBe('not_configured'); // wipayProvider.ts is deliberately never "configured" - see its own doc comment
  });

  it('reports not_connected (not not_configured) once credentials exist but no business has connected', async () => {
    process.env.GMAIL_CLIENT_ID = 'test-client-id';
    process.env.GMAIL_CLIENT_SECRET = 'test-client-secret';

    const health = await workspaceService.getIntegrationHealth(businessId);
    const google = health.integrations.find((i) => i.id === 'google_meet');
    expect(google?.state).toBe('not_connected');
  });

  it('reports connected once a business genuinely has a real WhatsApp account connected', async () => {
    await createTestAccount(businessId);
    const health = await workspaceService.getIntegrationHealth(businessId);
    const whatsapp = health.integrations.find((i) => i.id === 'whatsapp');
    expect(whatsapp?.state).toBe('connected');
  });

  it('reports not_connected for WhatsApp when no account exists for this business', async () => {
    const health = await workspaceService.getIntegrationHealth(businessId);
    const whatsapp = health.integrations.find((i) => i.id === 'whatsapp');
    expect(whatsapp?.state).toBe('not_connected');
  });

  it('always includes exactly one row per known integration, never a missing or duplicated entry', async () => {
    const health = await workspaceService.getIntegrationHealth(businessId);
    const ids = health.integrations.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length); // no duplicates
    expect(ids).toEqual(
      expect.arrayContaining([
        'google_meet', 'zoom', 'email_gmail', 'email_outlook', 'whatsapp',
        'ai_gemini', 'ai_goose', 'payment_bimpay', 'payment_paypal', 'payment_wipay',
      ]),
    );
  });

  it('never leaks another business\'s connection into this business\'s health view', async () => {
    const otherBusinessId = await createTestBusiness();
    await createTestAccount(otherBusinessId, '15550002222@s.whatsapp.net');

    const health = await workspaceService.getIntegrationHealth(businessId);
    const whatsapp = health.integrations.find((i) => i.id === 'whatsapp');
    expect(whatsapp?.state).toBe('not_connected');
  });
});
