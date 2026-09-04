import type { Express } from 'express';
import { propertyOperationsRouter } from './propertyOperationsRouter.js';
import { retailOperationsRouter } from './retailOperationsRouter.js';
import { platformApprovalRouter } from './platformApprovalRouter.js';
import { propertyConversationBindingRouter } from './propertyConversationBindingRouter.js';
import { productAccountRouter } from './productAccountRoutes.js';
import { billingRouter } from './billingRoutes.js';
import { invoiceRouter } from './invoiceRouter.js';
import { operatorModeRouter } from './operatorModeRouter.js';
import { legalRouter } from './legalRouter.js';
import { emailOAuthRouter } from './emailOAuthRouter.js';
import { meetingOAuthRouter } from './meetingOAuthRouter.js';
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
  app.use('/api/retail-operations', retailOperationsRouter);
  app.use('/api/platform/approvals', platformApprovalRouter);
  app.use('/api/platform', productAccountRouter);
  app.use('/api/billing', billingRouter);
  app.use('/api/invoices', invoiceRouter);
  app.use('/api/operator-mode', operatorModeRouter);
  // Public legal routes — no auth required (landing page consent flow).
  app.use('/api/legal', legalRouter);
  // Email OAuth — mix of public (callback) and authenticated routes.
  app.use('/api/email-oauth', emailOAuthRouter);
  // Google Meet booking OAuth — same mix, deliberately a separate router/mount
  // from email OAuth (see googleMeetingOAuthService.ts's own header comment).
  app.use('/api/meeting-oauth', meetingOAuthRouter);
}
