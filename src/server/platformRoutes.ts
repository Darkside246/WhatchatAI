import type { Express } from 'express';
import { propertyOperationsRouter } from './propertyOperationsRouter.js';
import { platformApprovalRouter } from './platformApprovalRouter.js';
import { propertyConversationBindingRouter } from './propertyConversationBindingRouter.js';
import { productAccountRouter } from './productAccountRoutes.js';
import { billingRouter } from './billingRoutes.js';
import { pool } from '../db/pool.js';
import { PlatformActionRepository } from '../repositories/platformActionRepository.js';
import { PlatformAuditLedgerRepository } from '../repositories/platformAuditLedgerRepository.js';
import { actionBusService } from '../services/platform/actionBusService.js';
import { auditLedgerService } from '../services/platform/auditLedgerService.js';

/** Explicit integration point for product, billing, and platform APIs. */
export function mountPlatformRoutes(app: Express): void {
  // Wire persistent repositories into the singleton services.
  // Done here (rather than at module level) so the pool is ready.
  actionBusService.setRepository(new PlatformActionRepository(pool));
  auditLedgerService.setRepository(new PlatformAuditLedgerRepository(pool));
  app.use('/api/property-operations', propertyOperationsRouter);
  app.use('/api/property-operations/conversations', propertyConversationBindingRouter);
  app.use('/api/platform/approvals', platformApprovalRouter);
  app.use('/api/platform', productAccountRouter);
  app.use('/api/billing', billingRouter);
}
