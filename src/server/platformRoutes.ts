import type { Express } from 'express';
import { propertyOperationsRouter } from './propertyOperationsRouter.js';
import { platformApprovalRouter } from './platformApprovalRouter.js';

/**
 * Explicit integration point for the platform API. Keep this separate from
 * individual routers so the main server can opt in with two predictable
 * mounts and the existing WhatsApp routes remain untouched.
 */
export function mountPlatformRoutes(app: Express): void {
  app.use('/api/property-operations', propertyOperationsRouter);
  app.use('/api/platform/approvals', platformApprovalRouter);
}
