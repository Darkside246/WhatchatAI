import { randomUUID } from 'node:crypto';
import type { Queryable } from '../../repositories/types.js';
import { PropertyOperationsRepository, type PropertyRecord, type UnitRecord, type AssetRecord, type VendorRecord, type IncidentRecord, type WorkOrderRecord, type KnowledgeItemRecord } from '../../repositories/propertyOperationsRepository.js';
import { classifyMaintenanceMessage } from './propertyMaintenancePolicy.js';

export type MaintenanceIntake = {
  businessId: string;
  propertyId: string;
  unitId?: string | undefined;
  assetId?: string | undefined;
  reservationId?: string | undefined;
  reportedByContactId?: string | undefined;
  channel: 'WHATSAPP' | 'VOICE' | 'SMS' | 'EMAIL' | 'WEB';
  title?: string | undefined;
  description: string;
  aiSummary?: string | undefined;
  confidence?: number | undefined;
};

export class PropertyOperationsService {
  constructor(private readonly repository: PropertyOperationsRepository) {}
  listProperties(businessId: string): Promise<PropertyRecord[]> { return this.repository.listProperties(businessId); }
  getProperty(businessId: string, propertyId: string): Promise<PropertyRecord | null> { return this.repository.getProperty(businessId, propertyId); }
  createProperty(input: Parameters<PropertyOperationsRepository['createProperty']>[0]): Promise<PropertyRecord> { return this.repository.createProperty(input); }
  listUnits(businessId: string, propertyId: string): Promise<UnitRecord[]> { return this.repository.listUnits(businessId, propertyId); }
  getUnit(businessId: string, unitId: string): Promise<UnitRecord | null> { return this.repository.getUnit(businessId, unitId); }
  createUnit(input: Parameters<PropertyOperationsRepository['createUnit']>[0]): Promise<UnitRecord> { return this.repository.createUnit(input); }
  listAssets(businessId: string, unitId: string): Promise<AssetRecord[]> { return this.repository.listAssets(businessId, unitId); }
  createAsset(input: Parameters<PropertyOperationsRepository['createAsset']>[0]): Promise<AssetRecord> { return this.repository.createAsset(input); }
  listVendors(businessId: string, category?: string): Promise<VendorRecord[]> { return this.repository.listVendors(businessId, category); }
  createVendor(input: Parameters<PropertyOperationsRepository['createVendor']>[0]): Promise<VendorRecord> { return this.repository.createVendor(input); }
  listIncidents(businessId: string, propertyId?: string): Promise<IncidentRecord[]> { return this.repository.listIncidents(businessId, propertyId); }
  listKnowledge(businessId: string, propertyId?: string, assetId?: string): Promise<KnowledgeItemRecord[]> { return this.repository.listKnowledge(businessId, propertyId, assetId); }

  async intakeMaintenance(input: MaintenanceIntake): Promise<{ incident: IncidentRecord; classification: ReturnType<typeof classifyMaintenanceMessage>; workOrderDraft: WorkOrderRecord | null }> {
    const property = await this.repository.getProperty(input.businessId, input.propertyId);
    if (!property) throw new Error('PROPERTY_NOT_FOUND');
    if (input.unitId && !await this.repository.getUnit(input.businessId, input.unitId)) throw new Error('UNIT_NOT_FOUND');
    const classification = classifyMaintenanceMessage(input.description);
    const incidentInput: Parameters<PropertyOperationsRepository['createIncident']>[0] = {
      id: randomUUID(), businessId: input.businessId, propertyId: input.propertyId, sourceChannel: input.channel,
      title: input.title ?? `${classification.category} maintenance issue`, description: input.description, category: classification.category,
      severity: classification.urgency, status: classification.humanEscalationRequired ? 'ESCALATED' : 'OPEN',
    };
    if (input.unitId !== undefined) incidentInput.unitId = input.unitId;
    if (input.assetId !== undefined) incidentInput.assetId = input.assetId;
    if (input.reservationId !== undefined) incidentInput.reservationId = input.reservationId;
    if (input.reportedByContactId !== undefined) incidentInput.reportedByContactId = input.reportedByContactId;
    if (input.confidence !== undefined) incidentInput.confidence = input.confidence;
    if (input.aiSummary !== undefined) incidentInput.aiSummary = input.aiSummary;
    const incident = await this.repository.createIncident(incidentInput);

    if (classification.recommendedNextStep !== 'CREATE_WORK_ORDER') return { incident, classification, workOrderDraft: null };
    const vendors = await this.repository.listVendors(input.businessId, classification.category.toLowerCase());
    const preferredVendor = vendors.find((vendor) => vendor.emergencyAvailable) ?? vendors[0];
    const workOrderInput: Parameters<PropertyOperationsRepository['createWorkOrder']>[0] = { id: randomUUID(), businessId: input.businessId, incidentId: incident.id, status: 'PENDING_APPROVAL', priority: classification.urgency, description: input.aiSummary ?? input.description };
    if (preferredVendor !== undefined) workOrderInput.vendorId = preferredVendor.id;
    const workOrderDraft = await this.repository.createWorkOrder(workOrderInput);
    return { incident, classification, workOrderDraft };
  }
}

export function createPropertyOperationsService(db: Queryable): PropertyOperationsService { return new PropertyOperationsService(new PropertyOperationsRepository(db)); }
