import { InvoiceRepository, type CreateInvoiceInput, type InvoiceRecord, type InvoiceLineItemRecord } from '../../repositories/invoiceRepository.js';
import type { Queryable } from '../../repositories/types.js';
import { renderInvoiceHtml, DEFAULT_INVOICE_CUSTOMIZATION, type InvoiceCustomization, type RenderableInvoice, type RenderableLineItem, type RenderableBusiness, type RenderableCustomer } from './invoiceTemplates.js';

export type InvoiceWithLines = { invoice: InvoiceRecord; lineItems: InvoiceLineItemRecord[] };

export class InvoiceService {
  private readonly repo: InvoiceRepository;

  constructor(db: Queryable) {
    this.repo = new InvoiceRepository(db);
  }

  async draft(input: CreateInvoiceInput): Promise<InvoiceWithLines> {
    return this.repo.create(input);
  }

  async get(businessId: string, invoiceId: string): Promise<InvoiceWithLines | null> {
    const invoice = await this.repo.findById(businessId, invoiceId);
    if (!invoice) return null;
    const lineItems = await this.repo.listLineItems(businessId, invoiceId);
    return { invoice, lineItems };
  }

  async list(businessId: string, opts?: { status?: string; documentType?: string; limit?: number; offset?: number }): Promise<InvoiceRecord[]> {
    return this.repo.list(businessId, opts);
  }

  async submitForApproval(businessId: string, invoiceId: string): Promise<InvoiceRecord | null> {
    const existing = await this.repo.findById(businessId, invoiceId);
    if (!existing || existing.status !== 'DRAFT') return null;
    return this.repo.updateStatus(businessId, invoiceId, 'PENDING_APPROVAL');
  }

  async approve(businessId: string, invoiceId: string): Promise<InvoiceRecord | null> {
    const existing = await this.repo.findById(businessId, invoiceId);
    if (!existing || existing.status !== 'PENDING_APPROVAL') return null;
    return this.repo.updateStatus(businessId, invoiceId, 'APPROVED');
  }

  async markSent(businessId: string, invoiceId: string): Promise<InvoiceRecord | null> {
    const existing = await this.repo.findById(businessId, invoiceId);
    if (!existing || !['APPROVED'].includes(existing.status)) return null;
    return this.repo.updateStatus(businessId, invoiceId, 'SENT');
  }

  async markPaid(businessId: string, invoiceId: string): Promise<InvoiceRecord | null> {
    return this.repo.updateStatus(businessId, invoiceId, 'PAID');
  }

  /**
   * Pre-send cancellation only (DRAFT/PENDING_APPROVAL/APPROVED) - matches
   * how real invoicing software (QuickBooks, Zoho) draws this line:
   * nothing has reached the customer yet, so cancelling is an honest "this
   * never happened." Once SENT/OVERDUE, use voidInvoice() instead - the
   * customer has already seen a real document with this invoice number, so
   * silently cancelling it would misrepresent what actually occurred.
   */
  async cancel(businessId: string, invoiceId: string): Promise<InvoiceRecord | null> {
    const existing = await this.repo.findById(businessId, invoiceId);
    if (!existing || !['DRAFT', 'PENDING_APPROVAL', 'APPROVED'].includes(existing.status)) return null;
    return this.repo.updateStatus(businessId, invoiceId, 'CANCELLED');
  }

  /**
   * Post-send nullification (SENT/OVERDUE only) - the invoice number and
   * record stay visible in history (never deleted), just marked void, the
   * same distinction QuickBooks/Zoho make between an unsent draft and an
   * already-issued document. A PAID invoice can never be voided here - a
   * real payment needs a credit note / refund process, which this app does
   * not yet have, not a status flip that would misrepresent real money
   * that already moved.
   */
  async voidInvoice(businessId: string, invoiceId: string): Promise<InvoiceRecord | null> {
    const existing = await this.repo.findById(businessId, invoiceId);
    if (!existing || !['SENT', 'OVERDUE'].includes(existing.status)) return null;
    return this.repo.updateStatus(businessId, invoiceId, 'VOID');
  }

  /**
   * Real, permanent deletion - DRAFT or CANCELLED only. Nothing has ever
   * left this system for either: cancel() only ever applies to
   * DRAFT/PENDING_APPROVAL/APPROVED, all pre-send statuses, so a CANCELLED
   * invoice was never seen by a customer any more than a DRAFT one was -
   * same reasoning, same rule. SENT/OVERDUE (and their VOID counterpart)
   * are the real line: a customer has already seen a document with this
   * invoice number, so those must stay forever, deleted or not.
   */
  async remove(businessId: string, invoiceId: string): Promise<boolean> {
    const existing = await this.repo.findById(businessId, invoiceId);
    if (!existing || !['DRAFT', 'CANCELLED'].includes(existing.status)) return false;
    return this.repo.delete(businessId, invoiceId);
  }

  async updateDetails(
    businessId: string,
    invoiceId: string,
    patch: Partial<Pick<InvoiceRecord, 'notes' | 'terms' | 'footerText' | 'dueDate' | 'taxBasisPoints' | 'currencyCode'>>,
  ): Promise<InvoiceRecord | null> {
    const existing = await this.repo.findById(businessId, invoiceId);
    if (!existing || !['DRAFT', 'PENDING_APPROVAL'].includes(existing.status)) return null;
    return this.repo.updateDetails(businessId, invoiceId, patch);
  }

  // ── PDF HTML template ────────────────────────────────────────────────────────

  /**
   * `business.brandColor`/`logoDataUrl` come straight from the businesses
   * row (see migration 941) - the same values the dashboard UI uses for its
   * own accent color, so an invoice a customer receives visually matches
   * the business's own branding rather than this app's default blue.
   * `customization` (migration 988) picks which of the 3 built-in
   * templates (invoiceTemplates.ts) to render and any block-level color
   * overrides on top of it - defaults to Classic/no overrides so a
   * business that never customizes anything renders exactly as before
   * this setting existed.
   */
  renderHtml(
    invoice: RenderableInvoice,
    lineItems: RenderableLineItem[],
    business: RenderableBusiness,
    customization: InvoiceCustomization = DEFAULT_INVOICE_CUSTOMIZATION,
    customer: RenderableCustomer | null = null,
  ): string {
    return renderInvoiceHtml({ invoice, lineItems, business, customer, customization });
  }
}
