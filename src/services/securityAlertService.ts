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
 * the lock-screen AlertNotifier - the triggering chat's own WhatsApp
 * *business* line (never the customer's name, phone number, or message
 * text) and an unread-count-based urgency tier. The line label identifies
 * one of the business's own connected accounts (public-facing, already
 * shown elsewhere in the app as "Connected as ..."), not the contact on the
 * other end of the conversation - it never selects anything from the
 * `whatsapp_chats`/contact side of the join.
 */
export async function listHumanTakeoverAlerts(businessId: string): Promise<HumanTakeoverAlert[]> {
  const chatRepository = new WhatsAppChatRepository(pool);
  const rows = await chatRepository.listHumanTakeoverAlerts(businessId);

  return rows.map((row) => ({
    chatId: row.chat_id,
    lineLabel: row.account_name?.trim() || row.phone_number?.trim() || `Line ${row.line_number}`,
    urgency: urgencyFromUnreadCount(row.unread_count),
    triggeredAt: row.updated_at,
  }));
}
