import type { Queryable } from './types.js';

export type ConsentRecord = {
  id: string;
  fullName: string;
  email: string;
  phone: string;
  termsVersion: string;
  privacyVersion: string;
  ipAddress: string | null;
  userAgent: string | null;
  marketingOptIn: boolean;
  confirmationMethod: 'email' | 'qr' | null;
  confirmedAt: string | null;
  createdAt: string;
};

export type ConsentConfirmationRecord = {
  id: string;
  consentId: string;
  token: string;
  method: 'email' | 'qr';
  usedAt: string | null;
  expiresAt: string;
  createdAt: string;
};

export class UserConsentRepository {
  constructor(private readonly db: Queryable) {}

  async create(input: {
    fullName: string;
    email: string;
    phone: string;
    termsVersion: string;
    privacyVersion: string;
    ipAddress: string | null;
    userAgent: string | null;
    marketingOptIn: boolean;
  }): Promise<ConsentRecord> {
    const result = await this.db.query(
      `INSERT INTO user_consents
         (full_name, email, phone, terms_version, privacy_version, ip_address, user_agent, marketing_opt_in)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        input.fullName,
        input.email,
        input.phone,
        input.termsVersion,
        input.privacyVersion,
        input.ipAddress,
        input.userAgent,
        input.marketingOptIn,
      ],
    );
    return this.mapConsent(result.rows[0] as Record<string, unknown>);
  }

  async createConfirmation(input: {
    consentId: string;
    token: string;
    method: 'email' | 'qr';
    expiresAt: Date;
  }): Promise<ConsentConfirmationRecord> {
    const result = await this.db.query(
      `INSERT INTO consent_confirmations (consent_id, token, method, expires_at)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [input.consentId, input.token, input.method, input.expiresAt.toISOString()],
    );
    return this.mapConfirmation(result.rows[0] as Record<string, unknown>);
  }

  async findConfirmationByToken(token: string): Promise<ConsentConfirmationRecord | null> {
    const result = await this.db.query(
      `SELECT * FROM consent_confirmations WHERE token = $1 LIMIT 1`,
      [token],
    );
    return result.rows[0] ? this.mapConfirmation(result.rows[0] as Record<string, unknown>) : null;
  }

  async markConfirmed(consentId: string, method: 'email' | 'qr', tokenId: string): Promise<void> {
    await this.db.query(
      `UPDATE user_consents SET confirmed_at = now(), confirmation_method = $1 WHERE id = $2`,
      [method, consentId],
    );
    await this.db.query(
      `UPDATE consent_confirmations SET used_at = now() WHERE id = $1`,
      [tokenId],
    );
  }

  private mapConsent(row: Record<string, unknown>): ConsentRecord {
    return {
      id: row['id'] as string,
      fullName: row['full_name'] as string,
      email: row['email'] as string,
      phone: row['phone'] as string,
      termsVersion: row['terms_version'] as string,
      privacyVersion: row['privacy_version'] as string,
      ipAddress: row['ip_address'] as string | null,
      userAgent: row['user_agent'] as string | null,
      marketingOptIn: row['marketing_opt_in'] as boolean,
      confirmationMethod: row['confirmation_method'] as 'email' | 'qr' | null,
      confirmedAt: row['confirmed_at'] ? (row['confirmed_at'] as Date).toISOString() : null,
      createdAt: (row['created_at'] as Date).toISOString(),
    };
  }

  private mapConfirmation(row: Record<string, unknown>): ConsentConfirmationRecord {
    return {
      id: row['id'] as string,
      consentId: row['consent_id'] as string,
      token: row['token'] as string,
      method: row['method'] as 'email' | 'qr',
      usedAt: row['used_at'] ? (row['used_at'] as Date).toISOString() : null,
      expiresAt: (row['expires_at'] as Date).toISOString(),
      createdAt: (row['created_at'] as Date).toISOString(),
    };
  }
}
