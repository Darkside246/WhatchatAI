import { randomUUID } from 'node:crypto';
import type { Queryable } from '../../repositories/types.js';
import { PropertyOperationsRepository, type PropertyRecord, type UnitRecord, type AssetRecord, type VendorRecord, type IncidentRecord, type WorkOrderRecord, type KnowledgeItemRecord } from '../../repositories/propertyOperationsRepository.js';
import { classifyMaintenanceMessage } from './propertyMaintenancePolicy.js';

export type MaintenanceIntake = {
  businessId: string;
  propertyId: string;
  unitId?: string;
  assetId?: string;
  reservationId?: string;
  reportedByContactId?: string;
  channel: 'WHATSAPP' | 'VOICE' | 'SMS' | 'EMAIL' | 'WEB';
  title?: string;
  description: string;
  aiSummary?: string;
  confidence?: number;
};

export class PropertyOperationsService {
  constructor(private readonly repository: PropertyOperationsRepository) {}

  listProperties(businessId: string): Promise<PropertyRecord[]> { return this.repository.listProperties(businessId); }
  getProperty(businessId: string, propertyId: string): Promise<PropertyRecord | null> { return this.repository.getProperty(businessId, propertyId); }
  listUnits(businessId: string, propertyId: string): Promise<UnitRecord[]> { return this.repository.listUnits(businessId, propertyId); }
  listAssets(businessId: string, unitId: string): Promise<AssetRecord[]> { return this.repository.listAssets(businessId, unitId); }
  listVendors(businessId: string, category?: string): Promise<VendorRecord[]> { return this.repository.listVendors(businessId, category); }
  listIncidents(businessId: string, propertyId?: string): Promise<IncidentRecord[]> { return this.repository.listIncidents(businessId, propertyId); }
  listKnowledge(businessId: string, propertyId?: string, assetId?: string): Promise<KnowledgeItemRecord[]> { return this.repository.listKnowledge(businessId, propertyId, assetId); }

  async intakeMaintenance(input: MaintenanceIntake): Promise<{ incident: IncidentRecord; classification: ReturnType<typeof classifyMaintenanceMessage>; workOrderDraft: WorkOrderRecord | null }> {
    const property = await this.repository.getProperty(input.businessId, input.propertyId);
    if (!property) throw new Error('PROPERTY_NOT_FOUND');
    const classification = classifyMaintenanceMessage(input.description);
    const incident = await this.repository.createIncident({
      id: randomUUID(),
      businessId: input.businessId,
      propertyId: input.propertyId,
      unitId: input.unitId,
      assetId: input.assetId,
      reservationId: input.reservationId,
      reportedByContactId: input.reportedByContactId,
      sourceChannel: input.channel,
      title: input.title ?? `${classification.category} maintenance issue`,
      description: input.description,
      category: classification.category,
      severity: classification.urgency,
      status: classification.humanEscalationRequired ? 'ESCALATED' : 'OPEN',
      confidence: input.confidence,
      aiSummary: input.aiSummary,
    });

    if (classification.recommendedNextStep !== 'CREATE_WORK_ORDER') {
      return { incident, classification, workOrderDraft: null };
    }

    const vendors = await this.repository.listVendors(input.businessId, classification.category.toLowerCase());
    const preferredVendor = vendors.find((vendor) => vendor.emergencyAvailable) ?? vendors[0];
    const workOrderDraft = await this.repository.createWorkOrder({
      id: randomUUID(),
      businessId: input.businessId,
      incidentId: incident.id,
      vendorId: preferredVendor?.id,
      status: 'PENDING_APPROVAL',
      priority: classification.urgency,
      description: input.aiSummary ?? input.description,
    });
    return { incident, classification, workOrderDraft };
  }
}

export function createPropertyOperationsService(db: Queryable): PropertyOperationsService {
  return new PropertyOperationsService(new PropertyOperationsRepository(db));
}
