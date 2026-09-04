import type { Queryable } from '../../repositories/types.js';
import { RetailOperationsRepository } from '../../repositories/retailOperationsRepository.js';

/**
 * Unlike PropertyContextService, there is no throw-if-missing gate here - a
 * retail business has one flat catalog, not a hierarchy the caller must
 * resolve into first. A productId is optional extra context, not a
 * required scope key.
 */
export class RetailContextService {
  constructor(private readonly repository: RetailOperationsRepository) {}

  async build(input: { businessId: string; productId?: string | undefined }): Promise<Record<string, unknown>> {
    const catalog = await this.repository.listProducts(input.businessId);
    const product = input.productId ? catalog.find((item) => item.id === input.productId) ?? null : null;

    return {
      product,
      relevantProducts: catalog.slice(0, 20),
    };
  }
}

export function createRetailContextService(db: Queryable): RetailContextService {
  return new RetailContextService(new RetailOperationsRepository(db));
}
