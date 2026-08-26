import type { Express } from 'express';
import { propertyOperationsRouter } from './propertyOperationsRouter.js';
import { platformApprovalRouter } from './platformApprovalRouter.js';
import { propertyConversationBindingRouter } from './propertyConversationBindingRouter.js';

/**
 * Explicit integration point for the platform API. Keep platform routers
 * separate from the existing WhatsApp/OpenClaw routes so each boundary can
 * be audited and disabled independently.
 */
export function mountPlatformRoutes(app: Express): void {
  app.use('/api/property-operations', propertyOperationsRouter);
  app.use('/api/property-operations/conversations', propertyConversationBindingRouter);
  app.use('/api/platform/approvals', platformApprovalRouter);
}
