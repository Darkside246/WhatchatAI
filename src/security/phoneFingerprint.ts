import { createHmac } from 'node:crypto';
import { readMasterKeyFromEnv } from './encryption/kmsKeyProvider.js';

/**
 * A stable, one-way, non-tenant-scoped fingerprint of an E.164 phone
 * number, derived from MASTER_ENCRYPTION_KEY - no new secret/env var
 * needed, mirroring deriveMasterKeyId's own HMAC-with-fixed-info-string
 * pattern in kmsKeyProvider.ts.
 *
 * Deliberately global rather than per-tenant: EncryptionService's DEK is
 * HMAC(masterKey, "tenant-dek:" + tenantId), which gives every business
 * its own key on purpose - reusing that path here would hash the same
 * real phone number differently for every new business a user creates,
 * silently defeating the one thing this fingerprint exists to catch (the
 * same person reusing one real phone across many trial signups).
 *
 * Never reversible back to the phone number, and has no other use than
 * exact-match dedup - this is what makes retaining it past account
 * deletion a defensible fraud-prevention exception rather than a real PII
 * retention.
 */
export function fingerprintPhoneNumber(e164Phone: string): string {
  const masterKey = readMasterKeyFromEnv();
  return createHmac('sha256', masterKey).update(`phone-fingerprint:${e164Phone}`).digest('hex');
}
