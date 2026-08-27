import type { Express } from 'express';
import { propertyOperationsRouter } from './propertyOperationsRouter.js';
import { platformApprovalRouter } from './platformApprovalRouter.js';
import { propertyConversationBindingRouter } from './propertyConversationBindingRouter.js';
import { productAccountRouter } from './productAccountRoutes.js';

/** Explicit integration point for product and platform APIs. */
export function mountPlatformRoutes(app: Express): void {
  app.use('/api/property-operations', propertyOperationsRouter);
  app.use('/api/property-operations/conversations', propertyConversationBindingRouter);
  app.use('/api/platform/approvals', platformApprovalRouter);
  app.use('/api/platform', productAccountRouter);
}
