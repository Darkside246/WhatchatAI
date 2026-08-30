import { pool } from '../db/pool.js';
import { WhatsAppChatRepository } from '../repositories/whatsappChatRepository.js';

export type AlertUrgency = 'HIGH' | 'MEDIUM' | 'LOW';

export interface HumanTakeoverAlert {
  chatId: string;
  lineLabel: string;
  urgency: AlertUrgency;
  triggeredAt: string;
  /** Only ever populated when the caller passes includeIdentity: true - see listHumanTakeoverAlerts's own doc comment. */
  customerName: string | null;
  customerPhoneNumber: string | null;
}

function urgencyFromUnreadCount(unreadCount: number): AlertUrgency {
  if (unreadCount >= 5) return 'HIGH';
  if (unreadCount >= 2) return 'MEDIUM';
  return 'LOW';
}

/**
 * Zero-Leak Rule (default): by default this service exposes only real,
 * derived, non-PII fields to the lock-screen AlertNotifier - the triggering
 * chat's own WhatsApp *business* line (never the customer's name, phone
 * number, or message text) and an unread-count-based urgency tier. The line
 * label identifies one of the business's own connected accounts
 * (public-facing, already shown elsewhere in the app as "Connected as
 * ..."), not the contact on the other end of the conversation.
 *
 * `includeIdentity` is an explicit, per-request opt-in (wired to a
 * user-controlled, default-OFF Settings toggle - see AlertNotifier.tsx) for
 * businesses that want to see which customer needs attention without
 * opening the chat. Deliberately request-scoped rather than always
 * returning the fields and only hiding them client-side: with the setting
 * off, the customer's identity never leaves the server at all, not just
 * "isn't rendered" - the strongest version of this guarantee available
 * without giving up the feature entirely.
 */
export async function listHumanTakeoverAlerts(businessId: string, includeIdentity = false): Promise<HumanTakeoverAlert[]> {
  const chatRepository = new WhatsAppChatRepository(pool);
  const rows = await chatRepository.listHumanTakeoverAlerts(businessId);

  return rows.map((row) => ({
    chatId: row.chat_id,
    lineLabel: row.account_name?.trim() || row.phone_number?.trim() || `Line ${row.line_number}`,
    urgency: urgencyFromUnreadCount(row.unread_count),
    triggeredAt: row.updated_at,
    customerName: includeIdentity ? (row.customer_name?.trim() || null) : null,
    customerPhoneNumber: includeIdentity ? (row.customer_phone_number?.trim() || null) : null,
  }));
}
