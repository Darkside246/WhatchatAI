import type { LeadStatusValue } from './api.js';

/**
 * Canonical funnel order - CrmRoute.tsx's Kanban board renders columns in
 * this order too. LOST is a valid exit from any open stage, not "further
 * along" than WON, but it still needs a fixed position for indexOf below.
 */
export const PIPELINE_STATUSES: LeadStatusValue[] = ['NEW', 'QUALIFIED', 'ENGAGED', 'WON', 'LOST'];

/**
 * Forward-only pipeline moves. Real bug fixed here: the previous
 * implementation only excluded the lead's *current* status, so a lead
 * sitting at ENGAGED still showed "-> New" and "-> Qualified" as clickable
 * options - stages it had already completed kept reappearing every time
 * the board re-rendered. WON/LOST are terminal - a closed lead offers no
 * further moves at all. LOST stays reachable from any open stage since
 * marking a lead lost is a valid exit at any point, not a stage to hide
 * once passed.
 */
export function nextPipelineOptions(status: LeadStatusValue): LeadStatusValue[] {
  if (status === 'WON' || status === 'LOST') return [];
  const currentIndex = PIPELINE_STATUSES.indexOf(status);
  return PIPELINE_STATUSES.filter((s) => s !== status && (s === 'LOST' || PIPELINE_STATUSES.indexOf(s) > currentIndex));
}
