import type { Queryable } from './types.js';
import type { JidMappingSource, MappingConfidence } from '../domain/whatsapp/types.js';

export interface WhatsAppJidMappingRecord {
  id: string;
  businessId: string;
  whatsappAccountId: string;
  lidJid: string;
  phoneJid: string | null;
  phoneNumber: string | null;
  source: JidMappingSource;
  confidence: MappingConfidence;
}

interface JidMappingRow {
  id: string;
  business_id: string;
  whatsapp_account_id: string;
  lid_jid: string;
  phone_jid: string | null;
  phone_number: string | null;
  source: JidMappingSource;
  confidence: MappingConfidence;
}

function toRecord(row: JidMappingRow): WhatsAppJidMappingRecord {
  return {
    id: row.id,
    businessId: row.business_id,
    whatsappAccountId: row.whatsapp_account_id,
    lidJid: row.lid_jid,
    phoneJid: row.phone_jid,
    phoneNumber: row.phone_number,
    source: row.source,
    confidence: row.confidence,
  };
}

export class WhatsAppJidMappingRepository {
  constructor(private readonly db: Queryable) {}

  /** Only ever called with a mapping Baileys itself supplied (key.remoteJidAlt) - never an inferred one. */
  async upsert(
    businessId: string,
    whatsappAccountId: string,
    lidJid: string,
    phoneJid: string | null,
    phoneNumber: string | null,
    source: JidMappingSource,
    confidence: MappingConfidence = 'high',
  ): Promise<WhatsAppJidMappingRecord> {
    const { rows } = await this.db.query<JidMappingRow>(
      `INSERT INTO whatsapp_jid_mappings
         (business_id, whatsapp_account_id, lid_jid, phone_jid, phone_number, source, confidence)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (business_id, whatsapp_account_id, lid_jid)
       DO UPDATE SET
         phone_jid = EXCLUDED.phone_jid,
         phone_number = EXCLUDED.phone_number,
         source = EXCLUDED.source,
         confidence = EXCLUDED.confidence,
         updated_at = now()
       RETURNING *`,
      [businessId, whatsappAccountId, lidJid, phoneJid, phoneNumber, source, confidence],
    );
    const row = rows[0];
    if (!row) throw new Error('whatsapp_jid_mappings upsert returned no row');
    return toRecord(row);
  }

  async findByLid(businessId: string, whatsappAccountId: string, lidJid: string): Promise<WhatsAppJidMappingRecord | null> {
    const { rows } = await this.db.query<JidMappingRow>(
      `SELECT * FROM whatsapp_jid_mappings WHERE business_id = $1 AND whatsapp_account_id = $2 AND lid_jid = $3`,
      [businessId, whatsappAccountId, lidJid],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }
}
