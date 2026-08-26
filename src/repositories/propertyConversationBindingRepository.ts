import type { Queryable } from './types.js';

export interface PropertyConversationBinding {
  businessId: string;
  chatId: string;
  propertyId: string;
  unitId: string | null;
  reservationId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export class PropertyConversationBindingRepository {
  constructor(private readonly db: Queryable) {}

  async get(businessId: string, chatId: string): Promise<PropertyConversationBinding | null> {
    const { rows } = await this.db.query<PropertyConversationBinding>(
      `SELECT business_id AS "businessId",chat_id AS "chatId",property_id AS "propertyId",unit_id AS "unitId",reservation_id AS "reservationId",created_at AS "createdAt",updated_at AS "updatedAt"
       FROM property_conversation_bindings WHERE business_id = $1 AND chat_id = $2`,
      [businessId, chatId],
    );
    return rows[0] ?? null;
  }

  async upsert(input: { businessId: string; chatId: string; propertyId: string; unitId?: string | null; reservationId?: string | null }): Promise<PropertyConversationBinding> {
    const { rows } = await this.db.query<PropertyConversationBinding>(
      `INSERT INTO property_conversation_bindings (business_id,chat_id,property_id,unit_id,reservation_id)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (business_id,chat_id) DO UPDATE SET property_id = EXCLUDED.property_id, unit_id = EXCLUDED.unit_id, reservation_id = EXCLUDED.reservation_id, updated_at = now()
       RETURNING business_id AS "businessId",chat_id AS "chatId",property_id AS "propertyId",unit_id AS "unitId",reservation_id AS "reservationId",created_at AS "createdAt",updated_at AS "updatedAt"`,
      [input.businessId,input.chatId,input.propertyId,input.unitId ?? null,input.reservationId ?? null],
    );
    if (!rows[0]) throw new Error('property conversation binding upsert returned no row');
    return rows[0];
  }

  async remove(businessId: string, chatId: string): Promise<boolean> {
    const result = await this.db.query('DELETE FROM property_conversation_bindings WHERE business_id = $1 AND chat_id = $2', [businessId, chatId]);
    return (result.rowCount ?? 0) > 0;
  }
}
