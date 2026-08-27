import type { ProductAccountStatus } from '../domain/platform/productAccounts.js';

export const TRIAL_DURATION_MS = 48 * 60 * 60 * 1000;
export const TRIAL_EXPIRING_THRESHOLD_MS = 6 * 60 * 60 * 1000;

export type TrialState = 'CREATED' | 'ACTIVE' | 'EXPIRING' | 'EXPIRED' | 'CONVERTED' | 'CANCELLED';

export interface TrialTiming {
  state: TrialState;
  startsAt: Date | null;
  endsAt: Date | null;
}

export function normalizeTrialEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function createTrialTiming(now = new Date()): TrialTiming {
  const startsAt = new Date(now.getTime());
  const endsAt = new Date(now.getTime() + TRIAL_DURATION_MS);
  return { state: 'ACTIVE', startsAt, endsAt };
}

export function deriveTrialState(trial: TrialTiming, now = new Date()): TrialState {
  if (trial.state === 'CONVERTED' || trial.state === 'CANCELLED' || trial.state === 'EXPIRED') return trial.state;
  if (!trial.startsAt || !trial.endsAt) return 'CREATED';
  if (now.getTime() >= trial.endsAt.getTime()) return 'EXPIRED';
  if (trial.endsAt.getTime() - now.getTime() <= TRIAL_EXPIRING_THRESHOLD_MS) return 'EXPIRING';
  return 'ACTIVE';
}

export function canUseProductAccount(state: TrialState, accountStatus: ProductAccountStatus, now = new Date(), endsAt?: Date | null): boolean {
  if (accountStatus !== 'ACTIVE') return false;
  if (state === 'CONVERTED') return true;
  if (state !== 'ACTIVE' && state !== 'EXPIRING') return false;
  return Boolean(endsAt && endsAt.getTime() > now.getTime());
}
