import { randomUUID } from 'node:crypto';
import { pool } from '../../db/pool.js';
import { RetailOperationsRepository, type RetailOrderItem } from '../../repositories/retailOperationsRepository.js';
import type { ActionExecutor, ActionExecutionContext } from '../platform/actionBusService.js';
import type { ActionRequest } from '../../domain/platform/contracts.js';

export const RETAIL_CREATE_ORDER_ACTION_TYPE = 'retail.create_order';

/**
 * The real production side effect behind a "create an order" action -
 * dispatched through ActionBusService only after a human has approved it
 * (see platformApprovalRouter.ts's runPostApprovalSideEffects), the same
 * pattern MaintenanceCreateWorkOrderExecutor uses for property. The AI's
 * proposed item list names products by free text (productNameOrRef), so
 * this executor resolves each one against the real catalog via
 * findProductsByNameForBusiness before writing the order - an unresolved
 * item is dropped from the order rather than invented with a guessed price.
 */
export class RetailCreateOrderExecutor implements ActionExecutor {
  readonly actionType = RETAIL_CREATE_ORDER_ACTION_TYPE;

  constructor(private readonly retailRepo = new RetailOperationsRepository(pool)) {}

  async execute(
    action: ActionRequest,
    _context: ActionExecutionContext,
  ): Promise<{ status: 'SUCCEEDED' | 'FAILED'; result?: unknown; error?: string | undefined }> {
    const payload = action.payload;
    const rawItems = Array.isArray(payload.items) ? payload.items : [];
    if (rawItems.length === 0) {
      return { status: 'FAILED', error: 'action payload has no items to order' };
    }

    try {
      const resolvedItems: RetailOrderItem[] = [];
      for (const raw of rawItems) {
        const ref = typeof (raw as Record<string, unknown>).productNameOrRef === 'string' ? (raw as Record<string, unknown>).productNameOrRef as string : '';
        const quantity = typeof (raw as Record<string, unknown>).quantity === 'number' ? (raw as Record<string, unknown>).quantity as number : 0;
        if (!ref || quantity <= 0) continue;
        const matches = await this.retailRepo.findProductsByNameForBusiness(action.tenantId, ref);
        const product = matches[0];
        if (!product) continue;
        // retail_products.price_cents is BIGINT - node-postgres returns it
        // as a string by default (no custom type parser configured for
        // this column, same quirk documented for property_work_orders'
        // approved_cost_cents elsewhere in this codebase), so
        // product.priceCents does not actually match its RetailProductRecord
        // `number` type at runtime here. Coerce explicitly so the JSONB
        // items array this order stores actually contains a JSON number,
        // not a JSON string masquerading as one.
        resolvedItems.push({ productId: product.id, name: product.name, quantity, unitPriceCents: Number(product.priceCents) });
      }

      if (resolvedItems.length === 0) {
        return { status: 'FAILED', error: 'no requested item could be matched to a real product' };
      }

      const totalCents = resolvedItems.reduce((sum, item) => sum + item.quantity * item.unitPriceCents, 0);
      const summary = typeof payload.summary === 'string' ? payload.summary : typeof payload.messageText === 'string' ? payload.messageText : 'Retail order';
      const order = await this.retailRepo.createOrder({
        id: randomUUID(),
        businessId: action.tenantId,
        sourceChannel: 'WHATSAPP',
        status: 'APPROVED',
        items: resolvedItems,
        totalCents,
        aiSummary: summary,
        confidence: typeof payload.confidence === 'number' ? payload.confidence : undefined,
      });

      for (const item of resolvedItems) {
        await this.retailRepo.updateProductStock(action.tenantId, item.productId, -item.quantity).catch(() => null);
      }

      return { status: 'SUCCEEDED', result: { orderId: order.id, totalCents: order.totalCents } };
    } catch (error) {
      return { status: 'FAILED', error: error instanceof Error ? error.message : String(error) };
    }
  }
}
