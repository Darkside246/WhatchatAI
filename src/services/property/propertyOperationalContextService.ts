import { PropertyOperationsRepository } from '../../repositories/propertyOperationsRepository.js';
import type { Queryable } from '../../repositories/types.js';

export interface PropertyOperationalContext {
  tenantId: string;
  property: Awaited<ReturnType<PropertyOperationsRepository['getProperty']>>;
  units: Awaited<ReturnType<PropertyOperationsRepository['listUnits']>>;
  assets: Array<Awaited<ReturnType<PropertyOperationsRepository['listAssets']>>[number]>;
  vendors: Awaited<ReturnType<PropertyOperationsRepository['listVendors']>>;
  knowledge: Awaited<ReturnType<PropertyOperationsRepository['listKnowledge']>>;
}

export class PropertyOperationalContextService {
  private readonly repository: PropertyOperationsRepository;
  constructor(db: Queryable) { this.repository = new PropertyOperationsRepository(db); }

  async build(tenantId: string, propertyId: string, assetId?: string): Promise<PropertyOperationalContext> {
    const property = await this.repository.getProperty(tenantId, propertyId);
    if (!property || property.businessId !== tenantId) throw new Error('PROPERTY_NOT_FOUND');
    const units = await this.repository.listUnits(tenantId, propertyId);
    const assetsNested = await Promise.all(units.map((unit) => this.repository.listAssets(tenantId, unit.id)));
    const assets = assetsNested.flat().filter((asset) => !assetId || asset.id === assetId);
    const category = assets.find((asset) => asset.id === assetId)?.category;
    const vendors = await this.repository.listVendors(tenantId, category);
    const knowledge = await this.repository.listKnowledge(tenantId, propertyId, assetId);
    return { tenantId, property, units, assets, vendors, knowledge };
  }
}
