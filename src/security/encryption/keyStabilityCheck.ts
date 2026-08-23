import type { Queryable } from '../../repositories/types.js';
import { pool } from '../../db/pool.js';
import { deriveMasterKeyId, readMasterKeyFromEnv } from './kmsKeyProvider.js';

/**
 * Boot-time guard for the single most dangerous MASTER_ENCRYPTION_KEY
 * failure mode: the key silently changing between restarts. Every
 * previously-encrypted row becomes permanently undecryptable the moment
 * that happens (a different master key always derives a different
 * per-tenant DEK - there is no way to recover the old plaintext without the
 * exact original key), and without this check the first anyone would know
 * is scattered AES-GCM auth failures days later, deep in a queue worker.
 *
 * Fingerprints the currently-configured key (masterKeyId - a non-secret
 * HMAC, never the key itself) against a single persisted row. First real
 * boot records it; every boot after that must match, or the process
 * refuses to start. ALLOW_MASTER_KEY_CHANGE=true is the explicit,
 * deliberate escape hatch for an operator who really does mean to rotate
 * the key and accepts that prior ciphertext becomes unreadable.
 */
export async function verifyMasterKeyStability(db: Queryable = pool): Promise<void> {
  const currentKeyId = deriveMasterKeyId(readMasterKeyFromEnv());

  const { rows } = await db.query<{ key_id: string }>('SELECT key_id FROM encryption_key_registry WHERE singleton = true');
  const recorded = rows[0]?.key_id;

  if (!recorded) {
    await db.query(
      `INSERT INTO encryption_key_registry (singleton, key_id) VALUES (true, $1)
       ON CONFLICT (singleton) DO NOTHING`,
      [currentKeyId],
    );
    return;
  }

  if (recorded === currentKeyId) return;

  if (process.env.ALLOW_MASTER_KEY_CHANGE === 'true') {
    console.warn(
      `[EncryptionKeyStability] MASTER_ENCRYPTION_KEY changed (${recorded} -> ${currentKeyId}) and ALLOW_MASTER_KEY_CHANGE=true acknowledges this. ` +
        'Every message encrypted under the previous key is now permanently unreadable. Recording the new fingerprint.',
    );
    await db.query('UPDATE encryption_key_registry SET key_id = $1, recorded_at = now() WHERE singleton = true', [currentKeyId]);
    return;
  }

  throw new Error(
    `MASTER_ENCRYPTION_KEY does not match the key this deployment was last run with (recorded fingerprint ${recorded}, ` +
      `current fingerprint ${currentKeyId}). Starting anyway would silently strand every message encrypted under the ` +
      'previous key - each would fail to decrypt only when something later tries to read it. If this key change is ' +
      'intentional and you accept that prior data becomes unreadable, set ALLOW_MASTER_KEY_CHANGE=true and restart once ' +
      'to acknowledge it.',
  );
}
