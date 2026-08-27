import type { Queryable } from './types.js';
import type { ProductKey } from '../domain/platform/productAccounts.js';
import type { TrialState } from '../services/trialPolicy.js';

interface TrialRow {
  id: string;
  trial_identity_id: string;
  email: string;
  user_id: string | null;
  product_id: string;
  product_key: ProductKey;
  product_account_id: string | null;
  state: TrialState;
  starts_at: Date | null;
  ends_at: Date | null;
  expired_at: Date | null;
  converted_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

function toTrial(row: TrialRow) {
  return {
    id: row.id,
    trialIdentityId: row.trial_identity_id,
    email: row.email,
    userId: row.user_id,
    productId: row.product_id,
    productKey: row.product_key,
    productAccountId: row.product_account_id,
    state: row.state,
    startsAt: row.starts_at?.toISOString() ?? null,
    endsAt: row.ends_at?.toISOString() ?? null,
    expiredAt: row.expired_at?.toISOString() ?? null,
    convertedAt: row.converted_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

const TRIAL_SELECT = `
  SELECT pt.id, pt.trial_identity_id, ti.email, ti.user_id,
         pt.product_id, pc.product_key, pt.product_account_id, pt.state,
         pt.starts_at, pt.ends_at, pt.expired_at, pt.converted_at,
         pt.created_at, pt.updated_at
    FROM product_trials pt
    JOIN trial_identities ti ON ti.id = pt.trial_identity_id
    JOIN product_catalog pc ON pc.id = pt.product_id
`;

export class TrialRepository {
  constructor(private readonly db: Queryable) {}

  async findIdentityByEmail(email: string) {
    const { rows } = await this.db.query<{ id: string; email: string; user_id: string | null }>(
      `SELECT id, email, user_id FROM trial_identities WHERE email = $1`, [email],
    );
    return rows[0] ?? null;
  }

  async findTrialByEmail(email: string) {
    const { rows } = await this.db.query<TrialRow>(`${TRIAL_SELECT} WHERE ti.email = $1`, [email]);
    return rows[0] ? toTrial(rows[0]) : null;
  }

  async findTrialById(id: string) {
    const { rows } = await this.db.query<TrialRow>(`${TRIAL_SELECT} WHERE pt.id = $1`, [id]);
    return rows[0] ? toTrial(rows[0]) : null;
  }

  async findTrialByProductAccountId(productAccountId: string) {
    const { rows } = await this.db.query<TrialRow>(`${TRIAL_SELECT} WHERE pt.product_account_id = $1`, [productAccountId]);
    return rows[0] ? toTrial(rows[0]) : null;
  }

  async updateState(id: string, state: TrialState, expiredAt: Date | null = null): Promise<void> {
    await this.db.query(
      `UPDATE product_trials
          SET state = $2,
              expired_at = CASE WHEN $2 = 'EXPIRED' THEN COALESCE($3, now()) ELSE expired_at END,
              updated_at = now()
        WHERE id = $1`,
      [id, state, expiredAt?.toISOString() ?? null],
    );
  }

  async attachAccount(id: string, productAccountId: string, userId: string): Promise<void> {
    await this.db.query(
      `UPDATE product_trials pt
          SET product_account_id = $2, updated_at = now()
        WHERE pt.id = $1
          AND EXISTS (SELECT 1 FROM trial_identities ti WHERE ti.id = pt.trial_identity_id AND ti.user_id = $3)`,
      [id, productAccountId, userId],
    );
  }
}
