export type SubscriptionStatus = 'ACTIVE' | 'TRIALING' | 'PAST_DUE' | 'PAUSED' | 'CANCELLED' | 'EXPIRED';

/** Statuses a subscription can be in and still be considered "live" (occupies the one-per-business slot). */
export const LIVE_SUBSCRIPTION_STATUSES: readonly SubscriptionStatus[] = [
  'ACTIVE',
  'TRIALING',
  'PAST_DUE',
  'PAUSED',
];

export type AgentStatus = 'ACTIVE' | 'PAUSED' | 'ARCHIVED';

export type LeadStatus = 'NEW' | 'QUALIFIED' | 'ENGAGED' | 'WON' | 'LOST';
