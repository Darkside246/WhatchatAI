import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { KmsKeyProvider } from './kmsKeyProvider.js';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH_BYTES = 12;
const CURRENT_ENVELOPE_VERSION = 1;

export interface EncryptedEnvelope {
  v: number;
  keyId: string;
  iv: string;
  authTag: string;
  ciphertext: string;
}

/** Real AES-256-GCM field-level envelope encryption. Node's crypto module uses OpenSSL's AES-NI path automatically when the CPU supports it. */
export class EncryptionService {
  constructor(private readonly keyProvider: KmsKeyProvider) {}

  async encryptField(tenantId: string, plaintext: string): Promise<EncryptedEnvelope> {
    const { keyId, key } = await this.keyProvider.getDataKey(tenantId);
    const iv = randomBytes(IV_LENGTH_BYTES);
    const cipher = createCipheriv(ALGORITHM, key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return {
      v: CURRENT_ENVELOPE_VERSION,
      keyId,
      iv: iv.toString('base64'),
      authTag: authTag.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    };
  }

  async decryptField(tenantId: string, envelope: EncryptedEnvelope): Promise<string> {
    if (envelope.v !== CURRENT_ENVELOPE_VERSION) {
      throw new Error(`Unsupported encryption envelope version: ${envelope.v}`);
    }
    const { key } = await this.keyProvider.getDataKey(tenantId);
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(envelope.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(envelope.authTag, 'base64'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
      decipher.final(),
    ]);
    return plaintext.toString('utf8');
  }

  /** Binary-safe counterpart of encryptField, for media bytes rather than text fields. */
  async encryptBuffer(tenantId: string, plaintext: Buffer): Promise<EncryptedEnvelope> {
    const { keyId, key } = await this.keyProvider.getDataKey(tenantId);
    const iv = randomBytes(IV_LENGTH_BYTES);
    const cipher = createCipheriv(ALGORITHM, key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return {
      v: CURRENT_ENVELOPE_VERSION,
      keyId,
      iv: iv.toString('base64'),
      authTag: authTag.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    };
  }

  async decryptBuffer(tenantId: string, envelope: EncryptedEnvelope): Promise<Buffer> {
    if (envelope.v !== CURRENT_ENVELOPE_VERSION) {
      throw new Error(`Unsupported encryption envelope version: ${envelope.v}`);
    }
    const { key } = await this.keyProvider.getDataKey(tenantId);
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(envelope.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(envelope.authTag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]);
  }

  /** Serializes an envelope to a single string safe for a TEXT column. */
  serialize(envelope: EncryptedEnvelope): string {
    return JSON.stringify(envelope);
  }

  /** Returns null (not an envelope) for plain legacy/unencrypted text rather than throwing, so callers can fall back. */
  tryParse(serialized: string): EncryptedEnvelope | null {
    try {
      const parsed = JSON.parse(serialized) as Partial<EncryptedEnvelope>;
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        typeof parsed.v === 'number' &&
        typeof parsed.keyId === 'string' &&
        typeof parsed.iv === 'string' &&
        typeof parsed.authTag === 'string' &&
        typeof parsed.ciphertext === 'string'
      ) {
        return parsed as EncryptedEnvelope;
      }
      return null;
    } catch {
      return null;
    }
  }
}
