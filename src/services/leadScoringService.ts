import type { Queryable } from '../repositories/types.js';
import { LeadRepository } from '../repositories/leadRepository.js';
import { CONVERSATION_FUNNEL_STAGES, CUSTOMER_READINESS_LEVELS, type ConversationFunnelStage, type CustomerReadiness } from '../repositories/conversationStateRepository.js';

/**
 * Section 11 (lead qualification): before this, `leads.score` and
 * `leads.status` were 100% human-entered - real DB columns with zero
 * computation behind them. This turns the real signals that already exist
 * elsewhere (Section 10's customer_readiness, Section 06's funnel_stage,
 * and real message-engagement counts) into an actual number, without
 * inventing a new signal source.
 *
 * Deliberately narrow: readiness and funnel stage are per-conversation
 * snapshots (conversation_states, chat-scoped), not per-lead, so this
 * looks at the contact's single most recently active chat - a contact
 * with several chats is an edge case this session's own scope does not
 * need to solve generically.
 */

const READINESS_POINTS: Record<CustomerReadiness, number> = {
  NOT_READY: 0, BROWSING: 10, NEEDS_INFORMATION: 25, COMPARING: 40,
  INTERESTED: 55, HIGHLY_INTERESTED: 70, READY_TO_ACT: 85, URGENT: 100,
};

const FUNNEL_STAGE_POINTS: Record<ConversationFunnelStage, number> = Object.fromEntries(
  CONVERSATION_FUNNEL_STAGES.map((stage, index) => [stage, Math.round((index / (CONVERSATION_FUNNEL_STAGES.length - 1)) * 100)]),
) as Record<ConversationFunnelStage, number>;

const MAX_ENGAGEMENT_MESSAGES = 20;
const COLD_LEAD_DAYS = 30;
const COLD_LEAD_PENALTY = 0.6;

export interface LeadScoringSignals {
  customerReadiness: CustomerReadiness | null;
  funnelStage: ConversationFunnelStage | null;
  messageCount: number;
  lastActivityAt: string | Date | null;
}

/** Pure, no I/O - every branch is independently testable without a database. */
export function computeLeadScore(signals: LeadScoringSignals, now: Date = new Date()): number {
  const readinessScore = signals.customerReadiness ? READINESS_POINTS[signals.customerReadiness] : null;
  const funnelScore = signals.funnelStage ? FUNNEL_STAGE_POINTS[signals.funnelStage] : null;
  const engagementScore = Math.min(signals.messageCount, MAX_ENGAGEMENT_MESSAGES) / MAX_ENGAGEMENT_MESSAGES * 100;

  let combined: number;
  if (readinessScore === null && funnelScore === null) {
    // No conversation_state has ever been written for this contact's chat
    // (e.g. no AI-handled conversation happened yet) - engagement volume
    // is the only real signal available.
    combined = engagementScore;
  } else {
    const conversationScore = readinessScore !== null && funnelScore !== null
      ? readinessScore * 0.55 + funnelScore * 0.45
      : (readinessScore ?? funnelScore)!;
    combined = conversationScore * 0.8 + engagementScore * 0.2;
  }

  if (signals.lastActivityAt) {
    const lastActivityMs = new Date(signals.lastActivityAt).getTime();
    const daysSinceActivity = (now.getTime() - lastActivityMs) / (1000 * 60 * 60 * 24);
    if (daysSinceActivity > COLD_LEAD_DAYS) combined *= COLD_LEAD_PENALTY;
  } else {
    combined *= COLD_LEAD_PENALTY;
  }

  return Math.max(0, Math.min(100, Math.round(combined)));
}

/** The threshold at which a brand-new lead with real signal behind it is worth surfacing to staff as qualified. */
export const AUTO_QUALIFY_THRESHOLD = 50;

interface SignalRow {
  message_count: number;
  last_message_at: string | null;
  funnel_stage: ConversationFunnelStage | null;
  customer_readiness: CustomerReadiness | null;
}

async function loadSignalsForContact(db: Queryable, businessId: string, crmContactId: string): Promise<LeadScoringSignals | null> {
  const { rows } = await db.query<SignalRow>(
    `SELECT wc.message_count, wc.last_message_at, cs.funnel_stage, cs.customer_readiness
     FROM crm_contacts c
     JOIN whatsapp_chats wc ON wc.contact_id = c.whatsapp_contact_id AND wc.business_id = c.business_id AND wc.deleted_at IS NULL
     LEFT JOIN conversation_states cs ON cs.chat_id = wc.id AND cs.business_id = c.business_id
     WHERE c.id = $1 AND c.business_id = $2 AND c.whatsapp_contact_id IS NOT NULL
     ORDER BY wc.last_message_at DESC NULLS LAST
     LIMIT 1`,
    [crmContactId, businessId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    customerReadiness: row.customer_readiness,
    funnelStage: row.funnel_stage,
    messageCount: row.message_count,
    lastActivityAt: row.last_message_at,
  };
}

/**
 * Fills a genuinely blank score once real signal exists, and auto-advances
 * a lead's status from NEW to QUALIFIED once it crosses AUTO_QUALIFY_THRESHOLD
 * - never anything beyond that (see leadRepository.ts's setScoreIfUnset/
 * autoQualifyIfNew doc comments for why both are structurally one-directional
 * and never overwrite a real manual decision). Silently does nothing when
 * the contact has no linked WhatsApp identity or no chat yet - there is no
 * real signal to compute from, so "nothing changed" is the honest outcome,
 * not an error.
 */
export async function recomputeLeadScoreForContact(db: Queryable, businessId: string, crmContactId: string): Promise<void> {
  const signals = await loadSignalsForContact(db, businessId, crmContactId);
  if (!signals) return;

  const score = computeLeadScore(signals);
  const leadRepository = new LeadRepository(db);
  const leads = await leadRepository.listByCrmContact(crmContactId);
  for (const lead of leads) {
    if (lead.businessId !== businessId) continue;
    await leadRepository.setScoreIfUnset(businessId, lead.id, score);
    if (score >= AUTO_QUALIFY_THRESHOLD) await leadRepository.autoQualifyIfNew(businessId, lead.id);
  }
}
