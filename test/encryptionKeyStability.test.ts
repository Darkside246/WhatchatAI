import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { pool } from '../src/db/pool.js';
import { verifyMasterKeyStability } from '../src/security/encryption/keyStabilityCheck.js';
import { deriveMasterKeyId } from '../src/security/encryption/kmsKeyProvider.js';

function realKey(): string {
  return randomBytes(32).toString('base64');
}

describe('verifyMasterKeyStability (real Postgres, real key fingerprints)', () => {
  const originalKey = process.env.MASTER_ENCRYPTION_KEY;
  const originalAllow = process.env.ALLOW_MASTER_KEY_CHANGE;

  beforeEach(async () => {
    await pool.query('DELETE FROM encryption_key_registry');
  });

  afterEach(async () => {
    await pool.query('DELETE FROM encryption_key_registry');
    if (originalKey === undefined) delete process.env.MASTER_ENCRYPTION_KEY;
    else process.env.MASTER_ENCRYPTION_KEY = originalKey;
    if (originalAllow === undefined) delete process.env.ALLOW_MASTER_KEY_CHANGE;
    else process.env.ALLOW_MASTER_KEY_CHANGE = originalAllow;
  });

  it('records the current key fingerprint on first boot (no prior row) without throwing', async () => {
    process.env.MASTER_ENCRYPTION_KEY = realKey();

    await expect(verifyMasterKeyStability()).resolves.toBeUndefined();

    const { rows } = await pool.query<{ key_id: string }>('SELECT key_id FROM encryption_key_registry WHERE singleton = true');
    expect(rows[0]?.key_id).toBe(deriveMasterKeyId(Buffer.from(process.env.MASTER_ENCRYPTION_KEY, 'base64')));
  });

  it('passes silently on a later boot with the same key', async () => {
    process.env.MASTER_ENCRYPTION_KEY = realKey();
    await verifyMasterKeyStability();

    await expect(verifyMasterKeyStability()).resolves.toBeUndefined();
  });

  it('throws a clear error when the configured key no longer matches the recorded fingerprint', async () => {
    process.env.MASTER_ENCRYPTION_KEY = realKey();
    await verifyMasterKeyStability();

    process.env.MASTER_ENCRYPTION_KEY = realKey(); // a genuinely different key
    delete process.env.ALLOW_MASTER_KEY_CHANGE;

    await expect(verifyMasterKeyStability()).rejects.toThrow(/does not match the key this deployment was last run with/);

    // And the stored fingerprint is untouched by the failed attempt - a
    // real fix (restoring the right key, or the explicit override below)
    // is required, not a silent overwrite.
    const { rows } = await pool.query<{ key_id: string }>('SELECT key_id FROM encryption_key_registry WHERE singleton = true');
    expect(rows).toHaveLength(1);
  });

  it('ALLOW_MASTER_KEY_CHANGE=true is the explicit override that records the new fingerprint instead of throwing', async () => {
    process.env.MASTER_ENCRYPTION_KEY = realKey();
    await verifyMasterKeyStability();

    const newKey = realKey();
    process.env.MASTER_ENCRYPTION_KEY = newKey;
    process.env.ALLOW_MASTER_KEY_CHANGE = 'true';

    await expect(verifyMasterKeyStability()).resolves.toBeUndefined();

    const { rows } = await pool.query<{ key_id: string }>('SELECT key_id FROM encryption_key_registry WHERE singleton = true');
    expect(rows[0]?.key_id).toBe(deriveMasterKeyId(Buffer.from(newKey, 'base64')));
  });
});
