import { redisClient } from '../../redis/client.js';
import type { KmsKeyProvider, TenantDataKey } from './kmsKeyProvider.js';

const DEK_TTL_SECONDS = 15 * 60; // 15-minute TTL, per the KMS caching requirement.
const CACHE_KEY_PREFIX = 'kms:dek:';

/**
 * Wraps a KmsKeyProvider with a real Redis cache so the (potentially
 * network-bound, in a real cloud-KMS deployment) key fetch doesn't happen on
 * every single message. The DEK itself is only ever kept in memory/Redis for
 * up to 15 minutes, never persisted to Postgres.
 */
export class CachedKmsKeyProvider implements KmsKeyProvider {
  constructor(private readonly inner: KmsKeyProvider) {}

  async getDataKey(tenantId: string): Promise<TenantDataKey> {
    const cacheKey = CACHE_KEY_PREFIX + tenantId;
    const cached = await redisClient.get(cacheKey);
    if (cached) {
      const parsed = JSON.parse(cached) as { keyId: string; key: string };
      return { keyId: parsed.keyId, key: Buffer.from(parsed.key, 'base64') };
    }

    const dek = await this.inner.getDataKey(tenantId);
    await redisClient.set(
      cacheKey,
      JSON.stringify({ keyId: dek.keyId, key: dek.key.toString('base64') }),
      'EX',
      DEK_TTL_SECONDS,
    );
    return dek;
  }
}
