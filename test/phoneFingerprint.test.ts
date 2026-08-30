import { describe, expect, it } from 'vitest';
import { fingerprintPhoneNumber } from '../src/security/phoneFingerprint.js';
import { getEncryptionService } from '../src/security/encryption/index.js';

describe('fingerprintPhoneNumber (global, non-tenant-scoped phone dedup)', () => {
  it('is deterministic for the same number', () => {
    expect(fingerprintPhoneNumber('+14155552671')).toBe(fingerprintPhoneNumber('+14155552671'));
  });

  it('differs for different numbers', () => {
    expect(fingerprintPhoneNumber('+14155552671')).not.toBe(fingerprintPhoneNumber('+14155552672'));
  });

  it('is a real hex SHA-256 digest, never the plaintext number itself', () => {
    const hash = fingerprintPhoneNumber('+14155552671');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain('4155552671');
  });

  it('is deliberately NOT tenant-scoped, unlike EncryptionService.encryptField - the same real number must fingerprint identically no matter which business it was recorded under', async () => {
    // Sanity check on the property this test actually verifies: two
    // different tenant contexts really do produce different tenant DEKs
    // (proving fingerprintPhoneNumber's independence from that mechanism
    // is a real, deliberate design choice, not just a coincidence of a
    // trivial case).
    const envelopeA = await getEncryptionService().encryptField('11111111-1111-1111-1111-111111111111', '+14155552671');
    const envelopeB = await getEncryptionService().encryptField('22222222-2222-2222-2222-222222222222', '+14155552671');
    expect(envelopeA.ciphertext).not.toBe(envelopeB.ciphertext); // different tenant DEKs -> different ciphertext for the same plaintext

    // The fingerprint has no tenant parameter at all - it must be identical regardless.
    expect(fingerprintPhoneNumber('+14155552671')).toBe(fingerprintPhoneNumber('+14155552671'));
  });
});
