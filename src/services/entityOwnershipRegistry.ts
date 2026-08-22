import { WhatsAppChatRepository } from '../repositories/whatsappChatRepository.js';
import { CrmContactRepository } from '../repositories/crmContactRepository.js';
import { LeadRepository } from '../repositories/leadRepository.js';
import { pool } from '../db/pool.js';

export type OwnershipDecision = 'AUTHORIZED' | 'NOT_FOUND' | 'NOT_AUTHORIZED';

export interface EntityOwnershipResolver {
  readonly entityType: string;
  /**
   * businessId is the tenant check; chatId identifies which real WhatsApp
   * conversation the request came from - the actor is derived from that
   * chat's own contact, never from anything inside the tool request's own
   * arguments (a claim like "I'm the owner" carried in a field has no path
   * to influence this).
   */
  resolve(businessId: string, chatId: string, entityId: string): Promise<OwnershipDecision>;
}

/**
 * Resolves whether the WhatsApp contact behind a given chat has the one
 * relationship this platform actually recognizes for a lead: being the
 * lead's own linked CRM contact. Deliberately does not treat a matching
 * phone number alone as authorization - the chain always goes through the
 * real `whatsapp_chats.contact_id -> crm_contacts.whatsapp_contact_id ->
 * leads.crm_contact_id` relationship, not a raw string comparison.
 */
export class LeadOwnershipResolver implements EntityOwnershipResolver {
  readonly entityType = 'lead';

  constructor(
    private readonly chatRepo: WhatsAppChatRepository = new WhatsAppChatRepository(pool),
    private readonly crmContactRepo: CrmContactRepository = new CrmContactRepository(pool),
    private readonly leadRepo: LeadRepository = new LeadRepository(pool),
  ) {}

  async resolve(businessId: string, chatId: string, entityId: string): Promise<OwnershipDecision> {
    const lead = await this.leadRepo.findById(entityId);
    // Cross-tenant: never distinguish "doesn't exist" from "exists in
    // another tenant" to the caller - both are NOT_FOUND.
    if (!lead || lead.businessId !== businessId) return 'NOT_FOUND';

    const chat = await this.chatRepo.findByIdForBusiness(chatId, businessId);
    if (!chat || !chat.contactId) return 'NOT_AUTHORIZED';

    const crmContact = await this.crmContactRepo.findByWhatsAppContact(businessId, chat.contactId);
    if (!crmContact) return 'NOT_AUTHORIZED';

    return crmContact.id === lead.crmContactId ? 'AUTHORIZED' : 'NOT_AUTHORIZED';
  }
}

export class EntityOwnershipRegistry {
  private readonly resolvers = new Map<string, EntityOwnershipResolver>();

  register(resolver: EntityOwnershipResolver): void {
    this.resolvers.set(resolver.entityType, resolver);
  }

  async resolve(entityType: string, businessId: string, chatId: string, entityId: string): Promise<OwnershipDecision> {
    const resolver = this.resolvers.get(entityType);
    if (!resolver) return 'NOT_FOUND'; // an entity type with no registered resolver is never implicitly authorized
    return resolver.resolve(businessId, chatId, entityId);
  }
}

export const entityOwnershipRegistry = new EntityOwnershipRegistry();
entityOwnershipRegistry.register(new LeadOwnershipResolver());
