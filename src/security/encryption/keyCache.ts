import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { redisClient } from '../../redis/client.js';
import type { KmsKeyProvider, TenantDataKey } from './kmsKeyProvider.js';

const DEK_TTL_SECONDS = 15 * 60;
const CACHE_KEY_PREFIX = 'kms:dek:';
const CACHE_VERSION = 1;

interface CacheEnvelope {
  version: number;
  keyId: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

function readConfiguredCacheKey(): Buffer | null {
  const raw = process.env.DEK_CACHE_ENCRYPTION_KEY;
  if (!raw?.trim()) return null;
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error('DEK_CACHE_ENCRYPTION_KEY must decode to exactly 32 bytes (AES-256).');
  return key;
}

/**
 * Redis is treated as an untrusted cache. The old implementation serialized
 * the raw DEK directly into Redis, making a Redis read compromise tenant
 * encryption. Cache entries are now AES-256-GCM wrapped and authenticated.
 *
 * Providers that cannot supply a wrapping key simply bypass Redis (rather
 * than putting plaintext key material there). EnvMasterKeyProvider exposes
 * its master key for this purpose; a remote KMS can opt in with
 * DEK_CACHE_ENCRYPTION_KEY.
 */
export class CachedKmsKeyProvider implements KmsKeyProvider {
  private readonly cacheKey: Buffer | null;

  constructor(private readonly inner: KmsKeyProvider) {
    const providerKey = (inner as KmsKeyProvider & { getCacheEncryptionKey?: () => Buffer }).getCacheEncryptionKey?.();
    this.cacheKey = providerKey ?? readConfiguredCacheKey();
    if (this.cacheKey && this.cacheKey.length !== 32) throw new Error('DEK cache wrapping key must be exactly 32 bytes.');
  }

  private wrap(cacheKey: string, dek: TenantDataKey): string {
    if (!this.cacheKey) throw new Error('DEK cache wrapping key is unavailable');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.cacheKey, iv);
    cipher.setAAD(Buffer.from(cacheKey, 'utf8'));
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify({ keyId: dek.keyId, key: dek.key.toString('base64') }), 'utf8'),
      cipher.final(),
    ]);
    return JSON.stringify({
      version: CACHE_VERSION,
      keyId: dek.keyId,
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    } satisfies CacheEnvelope);
  }

  private unwrap(cacheKey: string, serialized: string): TenantDataKey | null {
    if (!this.cacheKey) return null;
    try {
      const envelope = JSON.parse(serialized) as Partial<CacheEnvelope>;
      if (envelope.version !== CACHE_VERSION || !envelope.keyId || !envelope.iv || !envelope.tag || !envelope.ciphertext) return null;
      const decipher = createDecipheriv('aes-256-gcm', this.cacheKey, Buffer.from(envelope.iv, 'base64'));
      decipher.setAAD(Buffer.from(cacheKey, 'utf8'));
      decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
      const plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]);
      const parsed = JSON.parse(plaintext.toString('utf8')) as { keyId?: unknown; key?: unknown };
      if (parsed.keyId !== envelope.keyId || typeof parsed.keyId !== 'string' || typeof parsed.key !== 'string') return null;
      const key = Buffer.from(parsed.key, 'base64');
      if (key.length !== 32) return null;
      return { keyId: parsed.keyId, key };
    } catch {
      // A stale/plaintext/tampered cache entry is discarded and rehydrated
      // from the authoritative provider; it is never returned to callers.
      return null;
    }
  }

  async getDataKey(tenantId: string): Promise<TenantDataKey> {
    const cacheKey = CACHE_KEY_PREFIX + tenantId;
    if (this.cacheKey) {
      try {
        const cached = await redisClient.get(cacheKey);
        if (cached) {
          const parsed = this.unwrap(cacheKey, cached);
          if (parsed) return parsed;
          await redisClient.del(cacheKey);
        }
      } catch {
        // Redis is an optimization, not a key authority. A cache outage
        // must not make encryption unavailable, and must never cause a
        // plaintext fallback.
        console.warn('[CachedKmsKeyProvider] Redis cache unavailable; using the authoritative key provider');
      }
    }

    const dek = await this.inner.getDataKey(tenantId);
    if (this.cacheKey) {
      try {
        await redisClient.set(cacheKey, this.wrap(cacheKey, dek), 'EX', DEK_TTL_SECONDS);
      } catch {
        console.warn('[CachedKmsKeyProvider] Redis cache write failed; continuing without cache');
      }
    }
    return dek;
  }
}
