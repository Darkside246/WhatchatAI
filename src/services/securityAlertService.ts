import { pool } from '../db/pool.js';
import { WhatsAppChatRepository } from '../repositories/whatsappChatRepository.js';

export type AlertUrgency = 'HIGH' | 'MEDIUM' | 'LOW';

export interface HumanTakeoverAlert {
  chatId: string;
  lineLabel: string;
  urgency: AlertUrgency;
  triggeredAt: string;
}

function urgencyFromUnreadCount(unreadCount: number): AlertUrgency {
  if (unreadCount >= 5) return 'HIGH';
  if (unreadCount >= 2) return 'MEDIUM';
  return 'LOW';
}

/**
 * Zero-Leak Rule: this service exposes only real, derived, non-PII fields to
 * the lock-screen AlertNotifier - a stable per-business line ordinal and an
 * unread-count-based urgency tier. It never selects message text, contact
 * names, or phone numbers.
 */
export async function listHumanTakeoverAlerts(businessId: string): Promise<HumanTakeoverAlert[]> {
  const chatRepository = new WhatsAppChatRepository(pool);
  const rows = await chatRepository.listHumanTakeoverAlerts(businessId);

  return rows.map((row) => ({
    chatId: row.chat_id,
    lineLabel: `Line ${row.line_number}`,
    urgency: urgencyFromUnreadCount(row.unread_count),
    triggeredAt: row.updated_at,
  }));
}
