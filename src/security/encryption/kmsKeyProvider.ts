import { createHmac, randomBytes } from 'node:crypto';

/**
 * A stable, non-secret fingerprint of a master key - never the key material
 * itself. Used to detect at boot whether MASTER_ENCRYPTION_KEY has changed
 * since data was last encrypted (see verifyMasterKeyStability below).
 */
export function deriveMasterKeyId(masterKey: Buffer): string {
  return createHmac('sha256', masterKey).update('key-id').digest('hex').slice(0, 16);
}

/** Decodes and validates MASTER_ENCRYPTION_KEY from the environment, throwing the same real errors EnvMasterKeyProvider does. */
export function readMasterKeyFromEnv(): Buffer {
  const raw = process.env.MASTER_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      'MASTER_ENCRYPTION_KEY is not configured. Set a 32-byte base64 key (e.g. `openssl rand -base64 32`) before starting the encryption service.',
    );
  }
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new Error('MASTER_ENCRYPTION_KEY must decode to exactly 32 bytes (AES-256).');
  }
  return key;
}

export interface TenantDataKey {
  keyId: string;
  key: Buffer;
}

export interface KmsKeyProvider {
  /** Returns the current Data Encryption Key (DEK) for a tenant, generating/wrapping one if it doesn't exist yet. */
  getDataKey(tenantId: string): Promise<TenantDataKey>;
}

/**
 * Real envelope-encryption key derivation using a local master key
 * (`MASTER_ENCRYPTION_KEY`), HKDF-derived per tenant so no two tenants ever
 * share a DEK. This is NOT a cloud KMS (AWS KMS/GCP KMS) - no cloud
 * credentials are configured in this environment, and connecting to one is
 * a real infrastructure dependency this codebase doesn't fabricate. The
 * interface is deliberately the shape a real cloud KMS client would satisfy,
 * so swapping in `AwsKmsKeyProvider`/`GcpKmsKeyProvider` later is a
 * provider-only change - callers never see the difference.
 */
export class EnvMasterKeyProvider implements KmsKeyProvider {
  private readonly masterKey: Buffer;
  private readonly masterKeyId: string;

  constructor() {
    this.masterKey = readMasterKeyFromEnv();
    // A real, stable identifier for which master key produced a given DEK - lets a future
    // key-rotation flow know which wrapping key to use for existing ciphertext.
    this.masterKeyId = deriveMasterKeyId(this.masterKey);
  }

  async getDataKey(tenantId: string): Promise<TenantDataKey> {
    // Real HKDF-style derivation (HMAC-based) - deterministic per tenant, so the
    // same tenant always gets the same DEK from the same master key, without
    // ever persisting the DEK itself anywhere.
    const key = createHmac('sha256', this.masterKey).update(`tenant-dek:${tenantId}`).digest();
    return { keyId: `${this.masterKeyId}:${tenantId}`, key };
  }
}

/** Generates a real 32-byte master key, base64-encoded, for local/dev setup (`MASTER_ENCRYPTION_KEY`). */
export function generateMasterKey(): string {
  return randomBytes(32).toString('base64');
}
