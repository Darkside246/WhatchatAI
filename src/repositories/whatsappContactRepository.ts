import type { Queryable } from './types.js';
import type { WhatsAppJidKind } from '../domain/whatsapp/jid.js';
import type { SourceType } from '../domain/whatsapp/types.js';

export interface WhatsAppContactRecord {
  id: string;
  businessId: string;
  whatsappAccountId: string;
  whatsappJid: string;
  jidKind: WhatsAppJidKind;
  phoneNumber: string | null;
  displayName: string | null;
  pushName: string | null;
  verifiedName: string | null;
  shortName: string | null;
  businessName: string | null;
  isBusiness: boolean | null;
  isContact: boolean | null;
  profilePictureUrl: string | null;
  profilePictureMediaId: string | null;
  aboutText: string | null;
  sourceType: SourceType;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

interface ContactRow {
  id: string;
  business_id: string;
  whatsapp_account_id: string;
  whatsapp_jid: string;
  jid_kind: WhatsAppJidKind;
  phone_number: string | null;
  display_name: string | null;
  push_name: string | null;
  verified_name: string | null;
  short_name: string | null;
  business_name: string | null;
  is_business: boolean | null;
  is_contact: boolean | null;
  profile_picture_url: string | null;
  profile_picture_media_id: string | null;
  about_text: string | null;
  source_type: SourceType;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

function toRecord(row: ContactRow): WhatsAppContactRecord {
  return {
    id: row.id,
    businessId: row.business_id,
    whatsappAccountId: row.whatsapp_account_id,
    whatsappJid: row.whatsapp_jid,
    jidKind: row.jid_kind,
    phoneNumber: row.phone_number,
    displayName: row.display_name,
    pushName: row.push_name,
    verifiedName: row.verified_name,
    shortName: row.short_name,
    businessName: row.business_name,
    isBusiness: row.is_business,
    isContact: row.is_contact,
    profilePictureUrl: row.profile_picture_url,
    profilePictureMediaId: row.profile_picture_media_id,
    aboutText: row.about_text,
    sourceType: row.source_type,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

export interface UpsertContactInput {
  businessId: string;
  whatsappAccountId: string;
  whatsappJid: string;
  jidKind: WhatsAppJidKind;
  phoneNumber?: string | null;
  displayName?: string | null;
  pushName?: string | null;
  verifiedName?: string | null;
  shortName?: string | null;
  businessName?: string | null;
  isBusiness?: boolean | null;
  isContact?: boolean | null;
}

export class WhatsAppContactRepository {
  constructor(private readonly db: Queryable) {}

  /**
   * Upserts by the stable WhatsApp identity (business_id, whatsapp_account_id,
   * whatsapp_jid). A changed display/push name updates the existing row - it
   * never creates a second contact for the same JID.
   */
  async upsertFromWhatsApp(input: UpsertContactInput): Promise<WhatsAppContactRecord> {
    const { rows } = await this.db.query<ContactRow>(
      `INSERT INTO whatsapp_contacts
         (business_id, whatsapp_account_id, whatsapp_jid, jid_kind, phone_number,
          display_name, push_name, verified_name, short_name, business_name,
          is_business, is_contact)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (business_id, whatsapp_account_id, whatsapp_jid) WHERE deleted_at IS NULL
       DO UPDATE SET
         phone_number = COALESCE(EXCLUDED.phone_number, whatsapp_contacts.phone_number),
         display_name = COALESCE(EXCLUDED.display_name, whatsapp_contacts.display_name),
         push_name = COALESCE(EXCLUDED.push_name, whatsapp_contacts.push_name),
         verified_name = COALESCE(EXCLUDED.verified_name, whatsapp_contacts.verified_name),
         short_name = COALESCE(EXCLUDED.short_name, whatsapp_contacts.short_name),
         business_name = COALESCE(EXCLUDED.business_name, whatsapp_contacts.business_name),
         is_business = COALESCE(EXCLUDED.is_business, whatsapp_contacts.is_business),
         is_contact = COALESCE(EXCLUDED.is_contact, whatsapp_contacts.is_contact),
         updated_at = now()
       RETURNING *`,
      [
        input.businessId,
        input.whatsappAccountId,
        input.whatsappJid,
        input.jidKind,
        input.phoneNumber ?? null,
        input.displayName ?? null,
        input.pushName ?? null,
        input.verifiedName ?? null,
        input.shortName ?? null,
        input.businessName ?? null,
        input.isBusiness ?? null,
        input.isContact ?? null,
      ],
    );
    const row = rows[0];
    if (!row) throw new Error('whatsapp_contacts upsert returned no row');
    return toRecord(row);
  }

  async findByJid(
    businessId: string,
    whatsappAccountId: string,
    whatsappJid: string,
  ): Promise<WhatsAppContactRecord | null> {
    const { rows } = await this.db.query<ContactRow>(
      `SELECT * FROM whatsapp_contacts
       WHERE business_id = $1 AND whatsapp_account_id = $2 AND whatsapp_jid = $3 AND deleted_at IS NULL`,
      [businessId, whatsappAccountId, whatsappJid],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async findById(id: string): Promise<WhatsAppContactRecord | null> {
    const { rows } = await this.db.query<ContactRow>('SELECT * FROM whatsapp_contacts WHERE id = $1', [id]);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  /** Reconciliation read: @lid contacts with no phone number yet - real candidates for repair once a jid_mapping exists. */
  async findUnresolvedLidContacts(businessId: string, whatsappAccountId: string): Promise<WhatsAppContactRecord[]> {
    const { rows } = await this.db.query<ContactRow>(
      `SELECT * FROM whatsapp_contacts
       WHERE business_id = $1 AND whatsapp_account_id = $2 AND jid_kind = 'lid'
         AND phone_number IS NULL AND deleted_at IS NULL`,
      [businessId, whatsappAccountId],
    );
    return rows.map(toRecord);
  }

  /** Reconciliation read: contacts with no real name field at all - only a bare JID/phone is known. Report-only, never auto-named. */
  async countUnknownContacts(businessId: string, whatsappAccountId: string): Promise<number> {
    const { rows } = await this.db.query<{ count: string }>(
      `SELECT count(*) FROM whatsapp_contacts
       WHERE business_id = $1 AND whatsapp_account_id = $2 AND deleted_at IS NULL
         AND display_name IS NULL AND push_name IS NULL AND verified_name IS NULL AND business_name IS NULL`,
      [businessId, whatsappAccountId],
    );
    return Number(rows[0]?.count ?? 0);
  }

  /** Reconciliation repair: backfill a phone number that only became resolvable once an authoritative jid_mapping arrived. */
  async attachPhoneNumber(contactId: string, phoneNumber: string): Promise<void> {
    await this.db.query('UPDATE whatsapp_contacts SET phone_number = $2, updated_at = now() WHERE id = $1', [
      contactId,
      phoneNumber,
    ]);
  }

  /** Points this contact at its real, downloaded profile picture - only ever called once a fetch has actually succeeded. */
  async attachProfilePicture(contactId: string, mediaId: string): Promise<void> {
    await this.db.query('UPDATE whatsapp_contacts SET profile_picture_media_id = $2, updated_at = now() WHERE id = $1', [
      contactId,
      mediaId,
    ]);
  }

  async search(businessId: string, whatsappAccountId: string, term: string): Promise<WhatsAppContactRecord[]> {
    const { rows } = await this.db.query<ContactRow>(
      `SELECT * FROM whatsapp_contacts
       WHERE business_id = $1 AND whatsapp_account_id = $2 AND deleted_at IS NULL
         AND (
           display_name ILIKE $3 OR push_name ILIKE $3 OR verified_name ILIKE $3
           OR phone_number ILIKE $3 OR whatsapp_jid ILIKE $3
         )
       ORDER BY display_name NULLS LAST
       LIMIT 50`,
      [businessId, whatsappAccountId, `%${term}%`],
    );
    return rows.map(toRecord);
  }
}
