import { pool } from '../db/pool.js';
import { TrialRepository } from '../repositories/trialRepository.js';
import { createTrialTiming, deriveTrialState, normalizeTrialEmail, type TrialState } from './trialPolicy.js';
import type { ProductKey } from '../domain/platform/productAccounts.js';

const trials = new TrialRepository(pool);

export class TrialAlreadyUsedError extends Error {}
export class TrialProductUnavailableError extends Error {}
export class TrialNotFoundError extends Error {}

export async function hasUsedTrial(email: string): Promise<boolean> {
  return Boolean(await trials.findIdentityByEmail(normalizeTrialEmail(email)));
}

export async function startTrial(input: { email: string; productKey: ProductKey }): Promise<Awaited<ReturnType<TrialRepository['findTrialById']>>> {
  const email = normalizeTrialEmail(input.email);
  if (!email) throw new Error('Email is required.');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const existing = await client.query<{ id: string }>(
      `SELECT id FROM trial_identities WHERE email = $1 FOR UPDATE`, [email],
    );
    if (existing.rows[0]) throw new TrialAlreadyUsedError('This email has already received a trial.');

    const product = await client.query<{ id: string }>(
      `SELECT id FROM product_catalog WHERE product_key = $1 AND is_active = true`, [input.productKey],
    );
    const productId = product.rows[0]?.id;
    if (!productId) throw new TrialProductUnavailableError('The selected product is not available.');

    const identity = await client.query<{ id: string }>(
      `INSERT INTO trial_identities (email) VALUES ($1) RETURNING id`, [email],
    );
    const identityId = identity.rows[0]?.id;
    if (!identityId) throw new Error('Trial identity creation returned no id');

    const timing = createTrialTiming();
    if (!timing.startsAt || !timing.endsAt) throw new Error('Trial timing creation returned an incomplete time window');
    const trial = await client.query<{ id: string }>(
      `INSERT INTO product_trials (trial_identity_id, product_id, state, starts_at, ends_at)
       VALUES ($1, $2, 'ACTIVE', $3, $4) RETURNING id`,
      [identityId, productId, timing.startsAt.toISOString(), timing.endsAt.toISOString()],
    );
    const trialId = trial.rows[0]?.id;
    if (!trialId) throw new Error('Trial creation returned no id');

    await client.query('COMMIT');
    return trials.findTrialById(trialId);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function refreshTrialState(trialId: string, now = new Date()) {
  const trial = await trials.findTrialById(trialId);
  if (!trial) throw new TrialNotFoundError('Trial not found.');
  const currentState = trial.state as TrialState;
  const nextState = deriveTrialState({
    state: currentState,
    startsAt: trial.startsAt ? new Date(trial.startsAt) : null,
    endsAt: trial.endsAt ? new Date(trial.endsAt) : null,
  }, now);
  if (nextState !== currentState) {
    await trials.updateState(trial.id, nextState, nextState === 'EXPIRED' ? now : null);
  }
  return trials.findTrialById(trial.id);
}

export function trialStatusForAccess(state: TrialState, endsAt: string | null, accountStatus: 'ACTIVE' | 'RESTRICTED' | 'SUSPENDED' | 'CLOSED' | 'PROVISIONING'): {
  state: TrialState;
  access: boolean;
  requiresPayment: boolean;
} {
  const access = accountStatus === 'ACTIVE' && (state === 'CONVERTED' || ((state === 'ACTIVE' || state === 'EXPIRING') && Boolean(endsAt && new Date(endsAt).getTime() > Date.now())));
  return { state, access, requiresPayment: state === 'EXPIRED' || accountStatus === 'RESTRICTED' };
}
