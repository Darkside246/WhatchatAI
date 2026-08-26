import type { Queryable } from './types.js';

export interface PropertyRecord {
  id: string;
  businessId: string;
  name: string;
  propertyType: string;
  status: string;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  countryCode: string | null;
  timezone: string | null;
  guestInstructions: string | null;
  emergencyInstructions: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface UnitRecord { id: string; businessId: string; propertyId: string; name: string; status: string; metadata: Record<string, unknown>; }
export interface AssetRecord {
  id: string; businessId: string; unitId: string; category: string; name: string;
  manufacturer: string | null; model: string | null; serialNumber: string | null;
  location: string | null; instructions: string | null; metadata: Record<string, unknown>;
}
export interface VendorRecord {
  id: string; businessId: string; name: string; serviceCategories: string[];
  phone: string | null; whatsappAddress: string | null; email: string | null;
  emergencyAvailable: boolean; active: boolean; metadata: Record<string, unknown>;
}
export interface IncidentRecord {
  id: string; businessId: string; propertyId: string; unitId: string | null; assetId: string | null;
  reservationId: string | null; vendorId: string | null; reportedByContactId: string | null;
  sourceChannel: string; title: string; description: string | null; category: string;
  severity: string; status: string; confidence: number | null; aiSummary: string | null;
  createdAt: Date; updatedAt: Date; resolvedAt: Date | null;
}
export interface WorkOrderRecord {
  id: string; businessId: string; incidentId: string; vendorId: string | null; status: string;
  priority: string; scheduledFor: Date | null; estimatedCostCents: number | null; approvedCostCents: number | null;
  description: string; completionNotes: string | null; createdAt: Date; updatedAt: Date; completedAt: Date | null;
}
export interface KnowledgeItemRecord {
  id: string; businessId: string; propertyId: string | null; unitId: string | null; assetId: string | null;
  title: string; content: string; sourceType: string; sourceReference: string | null;
  active: boolean; version: number; createdAt: Date; updatedAt: Date;
}

function json(value: unknown): Record<string, unknown> { return (value && typeof value === 'object' && !Array.isArray(value)) ? value as Record<string, unknown> : {}; }

export class PropertyOperationsRepository {
  constructor(private readonly db: Queryable) {}

  async listProperties(businessId: string): Promise<PropertyRecord[]> {
    const { rows } = await this.db.query<PropertyRecord>(`SELECT id, business_id AS "businessId", name, property_type AS "propertyType", status, address_line_1 AS "addressLine1", address_line_2 AS "addressLine2", city, country_code AS "countryCode", timezone, guest_instructions AS "guestInstructions", emergency_instructions AS "emergencyInstructions", created_at AS "createdAt", updated_at AS "updatedAt" FROM property_properties WHERE business_id = $1 ORDER BY name`, [businessId]);
    return rows;
  }

  async getProperty(businessId: string, propertyId: string): Promise<PropertyRecord | null> {
    const { rows } = await this.db.query<PropertyRecord>(`SELECT id, business_id AS "businessId", name, property_type AS "propertyType", status, address_line_1 AS "addressLine1", address_line_2 AS "addressLine2", city, country_code AS "countryCode", timezone, guest_instructions AS "guestInstructions", emergency_instructions AS "emergencyInstructions", created_at AS "createdAt", updated_at AS "updatedAt" FROM property_properties WHERE business_id = $1 AND id = $2`, [businessId, propertyId]);
    return rows[0] ?? null;
  }

  async createProperty(input: Omit<PropertyRecord, 'createdAt' | 'updatedAt'>): Promise<PropertyRecord> {
    const { rows } = await this.db.query<PropertyRecord>(`INSERT INTO property_properties (id, business_id, name, property_type, status, address_line_1, address_line_2, city, country_code, timezone, guest_instructions, emergency_instructions) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id, business_id AS "businessId", name, property_type AS "propertyType", status, address_line_1 AS "addressLine1", address_line_2 AS "addressLine2", city, country_code AS "countryCode", timezone, guest_instructions AS "guestInstructions", emergency_instructions AS "emergencyInstructions", created_at AS "createdAt", updated_at AS "updatedAt"`, [input.id,input.businessId,input.name,input.propertyType,input.status,input.addressLine1,input.addressLine2,input.city,input.countryCode,input.timezone,input.guestInstructions,input.emergencyInstructions]);
    if (!rows[0]) throw new Error('property insert returned no row');
    return rows[0];
  }

  async listUnits(businessId: string, propertyId: string): Promise<UnitRecord[]> {
    const { rows } = await this.db.query<UnitRecord>(`SELECT id, business_id AS "businessId", property_id AS "propertyId", name, status, metadata FROM property_units WHERE business_id = $1 AND property_id = $2 ORDER BY name`, [businessId, propertyId]);
    return rows.map((row) => ({ ...row, metadata: json(row.metadata) }));
  }

  async createUnit(input: { id: string; businessId: string; propertyId: string; name: string; status?: string; metadata?: Record<string, unknown> }): Promise<UnitRecord> {
    const { rows } = await this.db.query<UnitRecord>(`INSERT INTO property_units (id,business_id,property_id,name,status,metadata) VALUES ($1,$2,$3,$4,$5,$6::jsonb) RETURNING id,business_id AS "businessId",property_id AS "propertyId",name,status,metadata`, [input.id,input.businessId,input.propertyId,input.name,input.status ?? 'ACTIVE',JSON.stringify(input.metadata ?? {})]);
    if (!rows[0]) throw new Error('unit insert returned no row');
    return { ...rows[0], metadata: json(rows[0].metadata) };
  }

  async listAssets(businessId: string, unitId: string): Promise<AssetRecord[]> {
    const { rows } = await this.db.query<AssetRecord>(`SELECT id,business_id AS "businessId",unit_id AS "unitId",category,name,manufacturer,model,serial_number AS "serialNumber",location,instructions,metadata FROM property_assets WHERE business_id = $1 AND unit_id = $2 ORDER BY category,name`, [businessId, unitId]);
    return rows.map((row) => ({ ...row, metadata: json(row.metadata) }));
  }

  async createAsset(input: { id: string; businessId: string; unitId: string; category: string; name: string; manufacturer?: string; model?: string; serialNumber?: string; location?: string; instructions?: string; metadata?: Record<string, unknown> }): Promise<AssetRecord> {
    const { rows } = await this.db.query<AssetRecord>(`INSERT INTO property_assets (id,business_id,unit_id,category,name,manufacturer,model,serial_number,location,instructions,metadata) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb) RETURNING id,business_id AS "businessId",unit_id AS "unitId",category,name,manufacturer,model,serial_number AS "serialNumber",location,instructions,metadata`, [input.id,input.businessId,input.unitId,input.category,input.name,input.manufacturer ?? null,input.model ?? null,input.serialNumber ?? null,input.location ?? null,input.instructions ?? null,JSON.stringify(input.metadata ?? {})]);
    if (!rows[0]) throw new Error('asset insert returned no row');
    return { ...rows[0], metadata: json(rows[0].metadata) };
  }

  async listVendors(businessId: string, category?: string): Promise<VendorRecord[]> {
    const params: unknown[] = [businessId];
    let sql = `SELECT id,business_id AS "businessId",name,service_categories AS "serviceCategories",phone,whatsapp_address AS "whatsappAddress",email,emergency_available AS "emergencyAvailable",active,metadata FROM property_vendors WHERE business_id = $1 AND active = TRUE`;
    if (category) { params.push(category); sql += ` AND $2 = ANY(service_categories)`; }
    sql += ' ORDER BY emergency_available DESC, name';
    const { rows } = await this.db.query<VendorRecord>(sql, params);
    return rows.map((row) => ({ ...row, serviceCategories: Array.isArray(row.serviceCategories) ? row.serviceCategories : [], metadata: json(row.metadata) }));
  }

  async createVendor(input: { id: string; businessId: string; name: string; serviceCategories?: string[]; phone?: string; whatsappAddress?: string; email?: string; emergencyAvailable?: boolean; metadata?: Record<string, unknown> }): Promise<VendorRecord> {
    const { rows } = await this.db.query<VendorRecord>(`INSERT INTO property_vendors (id,business_id,name,service_categories,phone,whatsapp_address,email,emergency_available,metadata) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) RETURNING id,business_id AS "businessId",name,service_categories AS "serviceCategories",phone,whatsapp_address AS "whatsappAddress",email,emergency_available AS "emergencyAvailable",active,metadata`, [input.id,input.businessId,input.name,input.serviceCategories ?? [],input.phone ?? null,input.whatsappAddress ?? null,input.email ?? null,input.emergencyAvailable ?? false,JSON.stringify(input.metadata ?? {})]);
    if (!rows[0]) throw new Error('vendor insert returned no row');
    return { ...rows[0], serviceCategories: Array.isArray(rows[0].serviceCategories) ? rows[0].serviceCategories : [], metadata: json(rows[0].metadata) };
  }

  async createIncident(input: { id: string; businessId: string; propertyId: string; unitId?: string; assetId?: string; reservationId?: string; reportedByContactId?: string; sourceChannel: string; title: string; description?: string; category: string; severity?: string; status?: string; confidence?: number; aiSummary?: string }): Promise<IncidentRecord> {
    const { rows } = await this.db.query<IncidentRecord>(`INSERT INTO property_incidents (id,business_id,property_id,unit_id,asset_id,reservation_id,reported_by_contact_id,source_channel,title,description,category,severity,status,confidence,ai_summary) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id,business_id AS "businessId",property_id AS "propertyId",unit_id AS "unitId",asset_id AS "assetId",reservation_id AS "reservationId",vendor_id AS "vendorId",reported_by_contact_id AS "reportedByContactId",source_channel AS "sourceChannel",title,description,category,severity,status,confidence,ai_summary AS "aiSummary",created_at AS "createdAt",updated_at AS "updatedAt",resolved_at AS "resolvedAt"`, [input.id,input.businessId,input.propertyId,input.unitId ?? null,input.assetId ?? null,input.reservationId ?? null,input.reportedByContactId ?? null,input.sourceChannel,input.title,input.description ?? null,input.category,input.severity ?? 'UNKNOWN',input.status ?? 'OPEN',input.confidence ?? null,input.aiSummary ?? null]);
    if (!rows[0]) throw new Error('incident insert returned no row');
    return rows[0];
  }

  async listIncidents(businessId: string, propertyId?: string): Promise<IncidentRecord[]> {
    const params: unknown[] = [businessId];
    let sql = `SELECT id,business_id AS "businessId",property_id AS "propertyId",unit_id AS "unitId",asset_id AS "assetId",reservation_id AS "reservationId",vendor_id AS "vendorId",reported_by_contact_id AS "reportedByContactId",source_channel AS "sourceChannel",title,description,category,severity,status,confidence,ai_summary AS "aiSummary",created_at AS "createdAt",updated_at AS "updatedAt",resolved_at AS "resolvedAt" FROM property_incidents WHERE business_id = $1`;
    if (propertyId) { params.push(propertyId); sql += ' AND property_id = $2'; }
    sql += ' ORDER BY created_at DESC';
    const { rows } = await this.db.query<IncidentRecord>(sql, params);
    return rows;
  }

  async createWorkOrder(input: { id: string; businessId: string; incidentId: string; vendorId?: string; priority?: string; status?: string; scheduledFor?: Date; estimatedCostCents?: number; description: string }): Promise<WorkOrderRecord> {
    const { rows } = await this.db.query<WorkOrderRecord>(`INSERT INTO property_work_orders (id,business_id,incident_id,vendor_id,status,priority,scheduled_for,estimated_cost_cents,description) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id,business_id AS "businessId",incident_id AS "incidentId",vendor_id AS "vendorId",status,priority,scheduled_for AS "scheduledFor",estimated_cost_cents AS "estimatedCostCents",approved_cost_cents AS "approvedCostCents",description,completion_notes AS "completionNotes",created_at AS "createdAt",updated_at AS "updatedAt",completed_at AS "completedAt"`, [input.id,input.businessId,input.incidentId,input.vendorId ?? null,input.status ?? 'PENDING_APPROVAL',input.priority ?? 'NORMAL',input.scheduledFor ?? null,input.estimatedCostCents ?? null,input.description]);
    if (!rows[0]) throw new Error('work order insert returned no row');
    return rows[0];
  }

  async listKnowledge(businessId: string, propertyId?: string, assetId?: string): Promise<KnowledgeItemRecord[]> {
    const params: unknown[] = [businessId];
    let sql = `SELECT id,business_id AS "businessId",property_id AS "propertyId",unit_id AS "unitId",asset_id AS "assetId",title,content,source_type AS "sourceType",source_reference AS "sourceReference",active,version,created_at AS "createdAt",updated_at AS "updatedAt" FROM property_knowledge_items WHERE business_id = $1 AND active = TRUE`;
    if (propertyId) { params.push(propertyId); sql += ` AND (property_id IS NULL OR property_id = $${params.length})`; }
    if (assetId) { params.push(assetId); sql += ` AND (asset_id IS NULL OR asset_id = $${params.length})`; }
    sql += ' ORDER BY version DESC, updated_at DESC';
    const { rows } = await this.db.query<KnowledgeItemRecord>(sql, params);
    return rows;
  }
}
