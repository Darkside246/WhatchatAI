import type { Queryable } from './types.js';

export type CustomerIdentityChannel = 'whatsapp' | 'email' | 'voice' | 'webchat';
export type CustomerIdentitySource = 'whatsapp_contact_link' | 'baileys_alt_jid' | 'crm_link' | 'manual' | 'verified';
export type CustomerIdentityConfidence = 'high' | 'medium' | 'low';

export interface CustomerRecord {
  id: string;
  businessId: string;
  displayName: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CustomerIdentityRecord {
  id: string;
  businessId: string;
  customerId: string;
  channel: CustomerIdentityChannel;
  identityType: string;
  identityValue: string;
  source: CustomerIdentitySource;
  confidence: CustomerIdentityConfidence;
  verifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface CustomerRow {
  id: string;
  business_id: string;
  display_name: string | null;
  created_at: string;
  updated_at: string;
}

interface CustomerIdentityRow {
  id: string;
  business_id: string;
  customer_id: string;
  channel: CustomerIdentityChannel;
  identity_type: string;
  identity_value: string;
  source: CustomerIdentitySource;
  confidence: CustomerIdentityConfidence;
  verified_at: string | null;
  created_at: string;
  updated_at: string;
}

function toCustomer(row: CustomerRow): CustomerRecord {
  return { id: row.id, businessId: row.business_id, displayName: row.display_name, createdAt: row.created_at, updatedAt: row.updated_at };
}

function toIdentity(row: CustomerIdentityRow): CustomerIdentityRecord {
  return {
    id: row.id,
    businessId: row.business_id,
    customerId: row.customer_id,
    channel: row.channel,
    identityType: row.identity_type,
    identityValue: row.identity_value,
    source: row.source,
    confidence: row.confidence,
    verifiedAt: row.verified_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * The channel-agnostic customer identity layer. Sits above existing
 * per-channel identity (whatsapp_contacts, whatsapp_jid_mappings) rather
 * than replacing it - a customer_identities row just says "this
 * (channel, identity_type, identity_value) belongs to this customer",
 * with the same provenance/confidence discipline whatsapp_jid_mappings
 * already established: never invent an identity, always record where it
 * came from.
 */
export class CustomerIdentityRepository {
  constructor(private readonly db: Queryable) {}

  async findCustomerIdByIdentity(
    businessId: string,
    channel: CustomerIdentityChannel,
    identityType: string,
    identityValue: string,
  ): Promise<string | null> {
    const { rows } = await this.db.query<{ customer_id: string }>(
      `SELECT customer_id FROM customer_identities
       WHERE business_id = $1 AND channel = $2 AND identity_type = $3 AND identity_value = $4`,
      [businessId, channel, identityType, identityValue],
    );
    return rows[0]?.customer_id ?? null;
  }

  async findById(businessId: string, customerId: string): Promise<CustomerRecord | null> {
    const { rows } = await this.db.query<CustomerRow>(
      `SELECT * FROM customers WHERE id = $1 AND business_id = $2`,
      [customerId, businessId],
    );
    return rows[0] ? toCustomer(rows[0]) : null;
  }

  async listIdentitiesForCustomer(businessId: string, customerId: string): Promise<CustomerIdentityRecord[]> {
    const { rows } = await this.db.query<CustomerIdentityRow>(
      `SELECT * FROM customer_identities WHERE business_id = $1 AND customer_id = $2 ORDER BY created_at`,
      [businessId, customerId],
    );
    return rows.map(toIdentity);
  }

  /**
   * Records that (channel, identityType, identityValue) belongs to
   * customerId. Idempotent: linking the same identity again just refreshes
   * source/confidence rather than erroring or duplicating. Never call this
   * with a fabricated identityValue - the one existing caller
   * (getOrCreateForWhatsAppContact) only ever passes a real whatsapp_contacts
   * row id that a transport (Baileys, via WhatsAppContactRepository) itself
   * supplied.
   */
  async linkIdentity(input: {
    businessId: string;
    customerId: string;
    channel: CustomerIdentityChannel;
    identityType: string;
    identityValue: string;
    source: CustomerIdentitySource;
    confidence?: CustomerIdentityConfidence;
  }): Promise<CustomerIdentityRecord> {
    const { rows } = await this.db.query<CustomerIdentityRow>(
      `INSERT INTO customer_identities (business_id, customer_id, channel, identity_type, identity_value, source, confidence)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (business_id, channel, identity_type, identity_value)
       DO UPDATE SET
         source = EXCLUDED.source,
         confidence = EXCLUDED.confidence,
         updated_at = now()
       RETURNING *`,
      [input.businessId, input.customerId, input.channel, input.identityType, input.identityValue, input.source, input.confidence ?? 'high'],
    );
    const row = rows[0];
    if (!row) throw new Error('customer_identities upsert returned no row');
    return toIdentity(row);
  }

  /**
   * The compatibility/lookup layer between existing WhatsApp identity and
   * the canonical customer: resolves an existing customer for this
   * whatsapp_contacts row if one is already linked, or creates both the
   * customer and the link if this is the first time this contact has been
   * seen. Safe to call on every inbound/outbound message - concurrent
   * callers racing to create the same contact's first customer are
   * resolved by the unique index on customer_identities, not by locking:
   * the loser's INSERT ... ON CONFLICT DO UPDATE simply attaches to
   * whichever customer won, and the orphaned customer row it also created
   * is a harmless, unlinked leftover rather than a correctness bug (no
   * other table references it yet).
   */
  async getOrCreateForWhatsAppContact(businessId: string, whatsappContactId: string, displayName: string | null = null): Promise<string> {
    const existing = await this.findCustomerIdByIdentity(businessId, 'whatsapp', 'whatsapp_contact_id', whatsappContactId);
    if (existing) return existing;

    const { rows } = await this.db.query<CustomerRow>(
      `INSERT INTO customers (business_id, display_name) VALUES ($1, $2) RETURNING *`,
      [businessId, displayName],
    );
    const customer = rows[0];
    if (!customer) throw new Error('customers insert returned no row');

    const identity = await this.linkIdentity({
      businessId,
      customerId: customer.id,
      channel: 'whatsapp',
      identityType: 'whatsapp_contact_id',
      identityValue: whatsappContactId,
      source: 'whatsapp_contact_link',
      confidence: 'high',
    });
    return identity.customerId;
  }
}
