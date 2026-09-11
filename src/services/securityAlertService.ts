import { pool } from '../db/pool.js';
import { WhatsAppChatRepository } from '../repositories/whatsappChatRepository.js';
import { resolveChatIdentity } from './chatIdentityService.js';

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

  const base = rows.map((row) => ({
    chatId: row.chat_id,
    lineLabel: row.account_name?.trim() || row.phone_number?.trim() || `Line ${row.line_number}`,
    urgency: urgencyFromUnreadCount(row.unread_count),
    triggeredAt: row.updated_at,
  }));

  // Identity off: nothing about the customer is read, resolved or returned -
  // the guarantee in this function's doc comment is that their identity
  // never leaves the server, so the resolution below must not run either.
  if (!includeIdentity) {
    return base.map((alert) => ({ ...alert, customerName: null, customerPhoneNumber: null }));
  }

  // whatsapp_chats.name on its own is not the customer's name. It is
  // frequently null for a conversation whose address-book name lives on a
  // contact row - and for a @lid chat, on the phone-keyed sibling row
  // entirely. Reading it directly is why an alert could show a bare number
  // for someone the chat list names correctly two inches below it.
  // chatIdentityService is the single place that resolution is done, and
  // every surface that names a conversation has to agree.
  return Promise.all(
    rows.map(async (row, index) => {
      const identity = await resolveChatIdentity(businessId, row.whatsapp_account_id, {
        chatJid: row.chat_jid,
        jidKind: row.jid_kind,
        name: row.customer_name,
        phoneNumber: row.customer_phone_number,
        contactId: row.contact_id,
      });
      // displayName falls back to the phone number, and past that to the
      // chat's own JID, when no real name is known. Repeating either as the
      // NAME would make "nobody has saved this person" look identical to
      // "they are named after their own number" - so it stays null and the
      // number is shown as a number. Same rule resolveNotificationSubject
      // applies for the same reason.
      const isRealName = identity.displayName !== row.chat_jid && identity.displayName !== identity.phoneNumber;
      return {
        ...base[index]!,
        customerName: isRealName ? identity.displayName : null,
        customerPhoneNumber: identity.phoneNumber,
      };
    }),
  );
}
