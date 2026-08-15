import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EncryptionService } from '../src/security/encryption/encryptionService.js';
import { EnvMasterKeyProvider } from '../src/security/encryption/kmsKeyProvider.js';
import { CachedKmsKeyProvider } from '../src/security/encryption/keyCache.js';
import { redisClient } from '../src/redis/client.js';

describe('EncryptionService (real AES-256-GCM, real Redis-backed key cache)', () => {
  let service: EncryptionService;

  beforeAll(() => {
    service = new EncryptionService(new CachedKmsKeyProvider(new EnvMasterKeyProvider()));
  });

  afterAll(async () => {
    await redisClient.quit();
  });

  it('round-trips real plaintext through real AES-256-GCM encryption', async () => {
    const plaintext = 'Real message body that must never be stored in the clear.';
    const envelope = await service.encryptField('tenant-a', plaintext);

    expect(envelope.ciphertext).not.toBe(plaintext);
    expect(envelope.ciphertext.length).toBeGreaterThan(0);

    const decrypted = await service.decryptField('tenant-a', envelope);
    expect(decrypted).toBe(plaintext);
  });

  it('produces different ciphertext for the same plaintext each time (random IV)', async () => {
    const plaintext = 'same text';
    const first = await service.encryptField('tenant-a', plaintext);
    const second = await service.encryptField('tenant-a', plaintext);

    expect(first.ciphertext).not.toBe(second.ciphertext);
    expect(first.iv).not.toBe(second.iv);
  });

  it('derives different keys for different tenants - one tenant can never decrypt another tenant\'s data', async () => {
    const envelope = await service.encryptField('tenant-a', 'tenant A secret');
    await expect(service.decryptField('tenant-b', envelope)).rejects.toThrow();
  });

  it('detects tampering via the real GCM auth tag', async () => {
    const envelope = await service.encryptField('tenant-a', 'authentic data');
    const tampered = { ...envelope, ciphertext: Buffer.from('tampered-bytes-here!').toString('base64') };
    await expect(service.decryptField('tenant-a', tampered)).rejects.toThrow();
  });

  it('actually caches the DEK in real Redis with the documented 15-minute TTL', async () => {
    await service.encryptField('tenant-cache-check', 'warm the cache');
    const cacheKey = (await redisClient.keys('kms:dek:tenant-cache-check')).at(0);
    expect(cacheKey).toBeTruthy();

    const ttl = await redisClient.ttl(cacheKey!);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(15 * 60);
  });

  it('round-trips through the serialize/tryParse helpers used for TEXT column storage', async () => {
    const envelope = await service.encryptField('tenant-a', 'stored as text');
    const serialized = service.serialize(envelope);
    expect(typeof serialized).toBe('string');

    const parsed = service.tryParse(serialized);
    expect(parsed).not.toBeNull();
    const decrypted = await service.decryptField('tenant-a', parsed!);
    expect(decrypted).toBe('stored as text');
  });

  it('tryParse returns null for plain non-envelope text instead of throwing', () => {
    expect(service.tryParse('just a plain string')).toBeNull();
    expect(service.tryParse('{"not":"an envelope"}')).toBeNull();
  });
});
