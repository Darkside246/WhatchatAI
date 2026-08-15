import type { Queryable } from './types.js';

export interface Argon2Params {
  memoryCostKib: number;
  timeCost: number;
  parallelism: number;
  hashLengthBytes: number;
}

export interface SecurityLockCredentialRecord {
  id: string;
  businessId: string;
  pinSalt: string;
  pinHash: string;
  argon2Params: Argon2Params;
  createdAt: string;
  updatedAt: string;
}

interface SecurityLockCredentialRow {
  id: string;
  business_id: string;
  pin_salt: string;
  pin_hash: string;
  argon2_params: Argon2Params;
  created_at: string;
  updated_at: string;
}

function toRecord(row: SecurityLockCredentialRow): SecurityLockCredentialRecord {
  return {
    id: row.id,
    businessId: row.business_id,
    pinSalt: row.pin_salt,
    pinHash: row.pin_hash,
    argon2Params: row.argon2_params,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class SecurityLockCredentialRepository {
  constructor(private readonly db: Queryable) {}

  async findByBusiness(businessId: string): Promise<SecurityLockCredentialRecord | null> {
    const { rows } = await this.db.query<SecurityLockCredentialRow>(
      'SELECT * FROM security_lock_credentials WHERE business_id = $1',
      [businessId],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  /** Only creates a credential if none exists yet - re-setting the PIN requires the previous one (not implemented in this pass). */
  async createIfAbsent(
    businessId: string,
    pinSalt: string,
    pinHash: string,
    argon2Params: Argon2Params,
  ): Promise<SecurityLockCredentialRecord | null> {
    const { rows } = await this.db.query<SecurityLockCredentialRow>(
      `INSERT INTO security_lock_credentials (business_id, pin_salt, pin_hash, argon2_params)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (business_id) DO NOTHING
       RETURNING *`,
      [businessId, pinSalt, pinHash, JSON.stringify(argon2Params)],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }
}
