import { EncryptionService } from './encryptionService.js';
import { EnvMasterKeyProvider } from './kmsKeyProvider.js';
import { CachedKmsKeyProvider } from './keyCache.js';

let instance: EncryptionService | null = null;

/** Lazily constructed so a missing MASTER_ENCRYPTION_KEY only fails when encryption is actually used, not at process boot. */
export function getEncryptionService(): EncryptionService {
  if (!instance) {
    instance = new EncryptionService(new CachedKmsKeyProvider(new EnvMasterKeyProvider()));
  }
  return instance;
}

export { EncryptionService } from './encryptionService.js';
export type { EncryptedEnvelope } from './encryptionService.js';
export { generateMasterKey } from './kmsKeyProvider.js';
