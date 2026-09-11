import { pool } from '../db/pool.js';
import { WhatsAppContactRepository } from '../repositories/whatsappContactRepository.js';
import { WhatsAppJidMappingRepository } from '../repositories/whatsappJidMappingRepository.js';
import { hasRealName, resolveDisplayName, type ContactNameSources } from '../domain/whatsapp/displayName.js';

/**
 * The single place a conversation's *customer-facing* identity is worked out.
 *
 * Every surface that names a conversation - the chat list, the chat header,
 * a notification - must agree, and must always describe the CUSTOMER, never
 * the operator whose WhatsApp account happens to be the one connected. A
 * notification reading "New message - <the operator's own name>" is the
 * failure mode this module exists to make impossible: nothing here ever
 * consults the connected account's own identity.
 *
 * Resolution is identity-based throughout - contact rows, and a LID<->phone
 * pairing Baileys itself supplied. Never message text, and never a guess.
 */

export interface ChatIdentityInput {
  chatJid: string;
  jidKind: string;
  name: string | null;
  phoneNumber: string | null;
  contactId: string | null;
}

export interface ResolvedChatIdentity {
  /** What a human should see. A real name when one is known, otherwise the real phone number, otherwise a clean truncated label - never a fabricated name, never the operator's. */
  displayName: string;
  /** The customer's own number when genuinely known, else null. Never the connected account's. */
  phoneNumber: string | null;
}

const contactRepository = new WhatsAppContactRepository(pool);
const jidMappingRepository = new WhatsAppJidMappingRepository(pool);

/**
 * Fills in a `@lid` conversation's missing name from the phone-keyed contact
 * row WhatsApp already synced for the same person.
 *
 * WhatsApp hands us the same human under two identities: the privacy `@lid`
 * a chat is addressed by, and the ordinary phone JID that contacts sync
 * arrives under. The address-book name lands on the phone-keyed row, while
 * the `@lid` row a chat points at frequently has no name at all - which is
 * why real conversations showed as "WhatsApp User (2694…)" in the chat list
 * while the very same person's status updates showed their real name.
 *
 * Strictly a read-side join over rows this tenant already has. It imports no
 * phone book, creates no contact, and stores nothing new. Only the name
 * fields are taken; the conversation keeps the routing identity it really
 * has.
 */
export async function borrowSiblingContactName(
  businessId: string,
  whatsappAccountId: string,
  phoneNumber: string | null,
  nameSources: ContactNameSources,
): Promise<ContactNameSources> {
  // Runs for ANY chat with no real name and a known number, not just @lid.
  // The LID case is the one that made this necessary, but it was never the
  // only one: whatsapp_chats.contact_id is null on a chat created from a
  // message whose contact had not been resolved yet, and COALESCE only ever
  // fills it in on a LATER upsert that supplies one. Until then an ordinary
  // @s.whatsapp.net conversation resolved to a bare phone number while the
  // named contact row for that exact number sat right there - which is what
  // "the notification still shows a number" looks like from the outside.
  // The guard that matters is hasRealName: a conversation that already has
  // a name never reaches the query.
  if (!phoneNumber || hasRealName(nameSources)) return nameSources;

  const sibling = await contactRepository.findNamedByPhoneNumber(businessId, whatsappAccountId, phoneNumber);
  if (!sibling) return nameSources;

  return {
    ...nameSources,
    verifiedName: sibling.verifiedName,
    businessName: sibling.businessName,
    displayName: sibling.displayName,
    username: sibling.username,
    pushName: sibling.pushName,
    shortName: sibling.shortName,
  };
}

/**
 * Resolves one conversation's customer identity. Best-effort by design: a
 * lookup failure degrades to the honest phone number or a clean JID label
 * rather than throwing, because every caller (a notification in particular)
 * is on a path where failing to name someone must never fail the operation
 * itself.
 */
export async function resolveChatIdentity(
  businessId: string,
  whatsappAccountId: string,
  chat: ChatIdentityInput,
): Promise<ResolvedChatIdentity> {
  let phoneNumber = chat.phoneNumber;
  // The chat row's own number is offered to the resolver from the start, not
  // just returned alongside it. resolveDisplayName's priority list ends
  // "...pushName, shortName, phoneNumber" before the raw-JID fallback, so
  // withholding it here inverted that last step: a conversation with a known
  // number but no contact row resolved to the raw JID, which is the one
  // thing resolveDisplayName's own doc comment says is not a name.
  let nameSources: ContactNameSources = { displayName: chat.name, phoneNumber, whatsappJid: chat.chatJid };

  try {
    const contact = chat.contactId ? await contactRepository.findById(chat.contactId) : null;
    if (contact) {
      nameSources = {
        verifiedName: contact.verifiedName,
        businessName: contact.businessName,
        displayName: contact.displayName ?? chat.name,
        username: contact.username,
        pushName: contact.pushName,
        shortName: contact.shortName,
        phoneNumber: contact.phoneNumber,
        whatsappJid: contact.whatsappJid,
      };
      phoneNumber = contact.phoneNumber ?? phoneNumber;
    }

    if (chat.jidKind === 'lid' && !phoneNumber) {
      const mapping = await jidMappingRepository.findByLid(businessId, whatsappAccountId, chat.chatJid);
      if (mapping?.phoneNumber) {
        phoneNumber = mapping.phoneNumber;
        nameSources = { ...nameSources, phoneNumber };
      }
    }

    nameSources = await borrowSiblingContactName(businessId, whatsappAccountId, phoneNumber, nameSources);
  } catch (error) {
    console.error(
      '[chatIdentityService] Falling back to the chat row\'s own identity:',
      error instanceof Error ? error.message : error,
    );
  }

  return { displayName: resolveDisplayName(nameSources), phoneNumber: phoneNumber ?? null };
}

/**
 * The customer label for a notification: a real name when known, otherwise
 * the real number. Deliberately returns null rather than a placeholder when
 * nothing real is known, so a caller writes an honest generic sentence
 * instead of naming someone who was never identified.
 */
export async function resolveNotificationSubject(
  businessId: string,
  whatsappAccountId: string,
  chat: ChatIdentityInput,
): Promise<string | null> {
  const identity = await resolveChatIdentity(businessId, whatsappAccountId, chat);
  if (identity.displayName && identity.displayName !== chat.chatJid) return identity.displayName;
  if (identity.phoneNumber) return identity.phoneNumber;
  return null;
}
