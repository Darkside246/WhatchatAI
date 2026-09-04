import { randomUUID } from 'node:crypto';
import type { Queryable } from '../../repositories/types.js';
import { RetailOperationsRepository, type RetailProductRecord, type RetailOrderRecord, type RetailOrderItem, type RetailNoteRecord } from '../../repositories/retailOperationsRepository.js';
import { classifyRetailMessage } from './retailOrderPolicy.js';

export type OrderIntake = {
  businessId: string;
  customerContactId?: string | undefined;
  sourceChannel: 'WHATSAPP' | 'VOICE' | 'SMS' | 'EMAIL' | 'WEB';
  items: RetailOrderItem[];
  fulfillmentMethod?: string | undefined;
  deliveryAddress?: string | undefined;
  notes?: string | undefined;
  aiSummary?: string | undefined;
  confidence?: number | undefined;
};

export class RetailOperationsService {
  constructor(private readonly repository: RetailOperationsRepository) {}
  listProducts(businessId: string, category?: string): Promise<RetailProductRecord[]> { return this.repository.listProducts(businessId, category); }
  getProduct(businessId: string, productId: string): Promise<RetailProductRecord | null> { return this.repository.getProduct(businessId, productId); }
  createProduct(input: Parameters<RetailOperationsRepository['createProduct']>[0]): Promise<RetailProductRecord> { return this.repository.createProduct(input); }
  listOrders(businessId: string, status?: string): Promise<RetailOrderRecord[]> { return this.repository.listOrders(businessId, status); }
  getOrder(businessId: string, orderId: string): Promise<RetailOrderRecord | null> { return this.repository.getOrder(businessId, orderId); }
  updateOrderStatus(businessId: string, orderId: string, status: 'PENDING_APPROVAL' | 'PENDING_POLICY' | 'APPROVED' | 'FULFILLED' | 'CANCELLED', options?: { notes?: string | undefined }): Promise<RetailOrderRecord | null> { return this.repository.updateOrderStatus(businessId, orderId, status, options); }
  listRetailNotes(businessId: string, productId: string): Promise<RetailNoteRecord[]> { return this.repository.listRetailNotes(businessId, productId); }
  createRetailNote(input: Parameters<RetailOperationsRepository['createRetailNote']>[0]): Promise<RetailNoteRecord> { return this.repository.createRetailNote(input); }

  /**
   * Manual/web order intake path (mirrors PropertyOperationsService's
   * intakeMaintenance): classifies the free-text notes with the same
   * deterministic rules the AI triage pipeline falls back to, then creates
   * the order directly at PENDING_APPROVAL (or ESCALATED-equivalent via
   * status) - the AI WhatsApp path goes through retailOrderOrchestrator.ts
   * instead, which produces an ActionRequest rather than writing the order
   * synchronously.
   */
  async intakeOrder(input: OrderIntake): Promise<{ order: RetailOrderRecord; classification: ReturnType<typeof classifyRetailMessage> }> {
    const classification = classifyRetailMessage(input.notes ?? '');
    const totalCents = input.items.reduce((sum, item) => sum + item.quantity * item.unitPriceCents, 0);
    const orderInput: Parameters<RetailOperationsRepository['createOrder']>[0] = {
      id: randomUUID(), businessId: input.businessId, sourceChannel: input.sourceChannel, items: input.items, totalCents,
      status: classification.humanEscalationRequired ? 'PENDING_POLICY' : 'PENDING_APPROVAL',
    };
    if (input.customerContactId !== undefined) orderInput.customerContactId = input.customerContactId;
    if (input.fulfillmentMethod !== undefined) orderInput.fulfillmentMethod = input.fulfillmentMethod;
    if (input.deliveryAddress !== undefined) orderInput.deliveryAddress = input.deliveryAddress;
    if (input.notes !== undefined) orderInput.notes = input.notes;
    if (input.aiSummary !== undefined) orderInput.aiSummary = input.aiSummary;
    if (input.confidence !== undefined) orderInput.confidence = input.confidence;
    const order = await this.repository.createOrder(orderInput);
    return { order, classification };
  }
}

export function createRetailOperationsService(db: Queryable): RetailOperationsService {
  return new RetailOperationsService(new RetailOperationsRepository(db));
}
