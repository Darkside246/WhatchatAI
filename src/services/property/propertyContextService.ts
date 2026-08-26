import type { Queryable } from '../../repositories/types.js';
import { PropertyOperationsRepository } from '../../repositories/propertyOperationsRepository.js';

export class PropertyContextService {
  constructor(private readonly repository: PropertyOperationsRepository) {}

  async build(input: { businessId: string; propertyId: string; unitId?: string; assetId?: string }): Promise<Record<string, unknown>> {
    const property = await this.repository.getProperty(input.businessId, input.propertyId);
    if (!property) throw new Error('PROPERTY_NOT_FOUND');

    const units = await this.repository.listUnits(input.businessId, input.propertyId);
    const unit = input.unitId ? units.find((item) => item.id === input.unitId) ?? null : null;
    if (input.unitId && !unit) throw new Error('UNIT_NOT_FOUND');

    const assets = input.unitId ? await this.repository.listAssets(input.businessId, input.unitId) : [];
    const asset = input.assetId ? assets.find((item) => item.id === input.assetId) ?? null : null;
    if (input.assetId && !asset) throw new Error('ASSET_NOT_FOUND');

    const knowledge = await this.repository.listKnowledge(input.businessId, input.propertyId, input.assetId);
    const vendors = await this.repository.listVendors(input.businessId, asset?.category ?? undefined);

    return {
      property: {
        id: property.id,
        name: property.name,
        propertyType: property.propertyType,
        city: property.city,
        countryCode: property.countryCode,
        timezone: property.timezone,
        guestInstructions: property.guestInstructions,
        emergencyInstructions: property.emergencyInstructions,
      },
      unit,
      asset,
      relevantKnowledge: knowledge.slice(0, 20),
      approvedVendors: vendors.slice(0, 20),
    };
  }
}

export function createPropertyContextService(db: Queryable): PropertyContextService {
  return new PropertyContextService(new PropertyOperationsRepository(db));
}
