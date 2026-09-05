import { describe, expect, it } from 'vitest';
import { queryAsTenant } from '../src/db/pool.js';
import { redactForAnalysis } from '../src/services/businessIntelligence/piiRedactionService.js';
import { BiSecurityAlertRepository } from '../src/repositories/biSecurityAlertRepository.js';
import { createTestBusiness, resetDatabase } from './helpers.js';

/**
 * No Goose service is configured in this test environment (no
 * GOOSE_SERVICE_URL), so every case here exercises Stage 1 (deterministic
 * regex) only - redactStage2 degrades to a no-op by construction, exactly
 * as it must for any business that hasn't set up Goose.
 */
describe('piiRedactionService.redactForAnalysis (real Postgres) - Stage 1 deterministic redaction', () => {
  it('redacts an email address and records a bi_security_alerts row, never the value itself', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();

    const redacted = await redactForAnalysis(businessId, 'Please reach me at jane.doe@example.com about my order.', 'chat');
    expect(redacted).not.toContain('jane.doe@example.com');
    expect(redacted).toContain('[REDACTED_EMAIL]');

    const alerts = await new BiSecurityAlertRepository(queryAsTenant(businessId)).listRecent(businessId);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.alertType).toBe('pii_detected');
    expect(JSON.stringify(alerts[0])).not.toContain('jane.doe@example.com');
  });

  it('redacts a phone number', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const redacted = await redactForAnalysis(businessId, 'Call me back at 555-867-5309 please.', 'chat');
    expect(redacted).not.toContain('555-867-5309');
    expect(redacted).toContain('[REDACTED_PHONE]');
  });

  it('redacts a card-like number sequence', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const redacted = await redactForAnalysis(businessId, 'My card is 4111 1111 1111 1111 for the deposit.', 'invoice');
    expect(redacted).not.toContain('4111 1111 1111 1111');
    expect(redacted).toContain('[REDACTED_NUMBER]');
  });

  it('redacts a secret/API-key-shaped token and flags it as secret_detected, distinct from pii_detected', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const redacted = await redactForAnalysis(businessId, 'Here is the key: sk-abcdefghijklmnopqrstuvwxyz0123 for the integration.', 'document');
    expect(redacted).not.toContain('sk-abcdefghijklmnopqrstuvwxyz0123');
    expect(redacted).toContain('[REDACTED_SECRET]');

    const alerts = await new BiSecurityAlertRepository(queryAsTenant(businessId)).listRecent(businessId);
    expect(alerts.map((a) => a.alertType)).toContain('secret_detected');
  });

  it('clean text with no PII passes through unchanged and logs no alert', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const original = 'The battery life on Widget X has been great this month.';
    const redacted = await redactForAnalysis(businessId, original, 'chat');
    expect(redacted).toBe(original);

    const alerts = await new BiSecurityAlertRepository(queryAsTenant(businessId)).listRecent(businessId);
    expect(alerts).toHaveLength(0);
  });

  it('never throws even for empty content, and degrades to a no-op', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    await expect(redactForAnalysis(businessId, '', 'chat')).resolves.toBe('');
  });
});
