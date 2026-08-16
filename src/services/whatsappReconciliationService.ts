import { pool } from '../db/pool.js';
import { WhatsAppChatRepository } from '../repositories/whatsappChatRepository.js';
import { WhatsAppContactRepository } from '../repositories/whatsappContactRepository.js';
import { WhatsAppGroupRepository } from '../repositories/whatsappGroupRepository.js';
import { WhatsAppStatusRepository } from '../repositories/whatsappStatusRepository.js';
import { WhatsAppJidMappingRepository } from '../repositories/whatsappJidMappingRepository.js';

export interface ReconciliationReport {
  chatsMissingContactFound: number;
  chatsMissingContactRepaired: number;
  unresolvedLidContactsFound: number;
  unresolvedLidContactsRepaired: number;
  unknownContacts: number;
  groupsMissingMembers: number;
  statusesWithUnresolvedPublisher: number;
}

/**
 * Runs after the main sync import completes. Only ever repairs a record
 * when the authoritative data to do so already exists elsewhere in the
 * database (a contact that arrived after its chat, a jid_mapping that
 * arrived after its contact) - it never invents an identity. Everything
 * else is counted and reported, not silently "fixed" by guessing.
 *
 * Deliberately does NOT attempt cross-JID contact deduplication/merging:
 * merging two contact rows would touch every FK that points at them
 * (chats.contact_id, messages.sender_contact_id, group_members.
 * participant_contact_id), and the schema's own unique index already
 * prevents true same-JID duplicates. A temporary unknown/unresolved
 * record is acceptable; a risky automatic merge is not.
 */
export class WhatsAppReconciliationService {
  private readonly chatRepository = new WhatsAppChatRepository(pool);
  private readonly contactRepository = new WhatsAppContactRepository(pool);
  private readonly groupRepository = new WhatsAppGroupRepository(pool);
  private readonly statusRepository = new WhatsAppStatusRepository(pool);
  private readonly jidMappingRepository = new WhatsAppJidMappingRepository(pool);

  async run(businessId: string, whatsappAccountId: string): Promise<ReconciliationReport> {
    const [chatsRepaired, lidRepaired, unknownContacts, groupsMissingMembers, statusesUnresolved] = await Promise.all([
      this.repairChatsMissingContact(businessId, whatsappAccountId),
      this.repairUnresolvedLidContacts(businessId, whatsappAccountId),
      this.contactRepository.countUnknownContacts(businessId, whatsappAccountId),
      this.groupRepository.countMissingMembers(businessId, whatsappAccountId),
      this.statusRepository.countUnresolvedPublishers(businessId, whatsappAccountId),
    ]);

    return {
      chatsMissingContactFound: chatsRepaired.found,
      chatsMissingContactRepaired: chatsRepaired.repaired,
      unresolvedLidContactsFound: lidRepaired.found,
      unresolvedLidContactsRepaired: lidRepaired.repaired,
      unknownContacts,
      groupsMissingMembers,
      statusesWithUnresolvedPublisher: statusesUnresolved,
    };
  }

  private async repairChatsMissingContact(
    businessId: string,
    whatsappAccountId: string,
  ): Promise<{ found: number; repaired: number }> {
    const chats = await this.chatRepository.findMissingContactLinks(businessId, whatsappAccountId);
    let repaired = 0;
    for (const chat of chats) {
      const contact = await this.contactRepository.findByJid(businessId, whatsappAccountId, chat.chatJid);
      if (contact) {
        await this.chatRepository.attachContact(chat.id, contact.id);
        repaired += 1;
      }
    }
    return { found: chats.length, repaired };
  }

  private async repairUnresolvedLidContacts(
    businessId: string,
    whatsappAccountId: string,
  ): Promise<{ found: number; repaired: number }> {
    const contacts = await this.contactRepository.findUnresolvedLidContacts(businessId, whatsappAccountId);
    let repaired = 0;
    for (const contact of contacts) {
      const mapping = await this.jidMappingRepository.findByLid(businessId, whatsappAccountId, contact.whatsappJid);
      if (mapping?.phoneNumber) {
        await this.contactRepository.attachPhoneNumber(contact.id, mapping.phoneNumber);
        repaired += 1;
      }
    }
    return { found: contacts.length, repaired };
  }
}

export const whatsappReconciliationService = new WhatsAppReconciliationService();
