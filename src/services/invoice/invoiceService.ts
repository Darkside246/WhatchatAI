import { InvoiceRepository, type CreateInvoiceInput, type InvoiceRecord, type InvoiceLineItemRecord } from '../../repositories/invoiceRepository.js';
import type { Queryable } from '../../repositories/types.js';

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
   */
  renderHtml(
    invoice: InvoiceRecord,
    lineItems: InvoiceLineItemRecord[],
    business: { name: string; brandColor: string | null; logoDataUrl: string | null },
  ): string {
    const currency = invoice.currencyCode;
    const fmt = (cents: number) => `${currency} ${(cents / 100).toFixed(2)}`;
    const taxPct = (invoice.taxBasisPoints / 100).toFixed(2);
    const accent = business.brandColor ?? '#0a84ff';
    const logoHtml = business.logoDataUrl
      ? `<img src="${business.logoDataUrl}" alt="" style="max-height:48px;max-width:180px;margin-bottom:8px;display:block;" />`
      : '';

    const rows = lineItems
      .map(
        (li) => `<tr>
          <td>${li.description}</td>
          <td class="num">${parseFloat(li.quantity).toFixed(2)}</td>
          <td class="num">${fmt(li.unitPriceCents)}</td>
          <td class="num">${(li.discountBasisPoints / 100).toFixed(0)}%</td>
          <td class="num">${fmt(li.totalCents)}</td>
        </tr>`,
      )
      .join('\n');

    const taxCents = Math.round(invoice.subtotalCents * invoice.taxBasisPoints / 10000);

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; font-size:13px; color:#1a1a2e; padding:40px; }
  .header { display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:40px; }
  .brand { font-size:22px; font-weight:700; }
  .meta th { text-align:left; font-weight:600; padding-right:12px; color:#666; }
  .meta td { padding-right:8px; }
  h2 { font-size:18px; margin-bottom:16px; text-transform:uppercase; letter-spacing:.05em; color:${accent}; }
  table.items { width:100%; border-collapse:collapse; margin:24px 0; }
  table.items th { background:#f4f6fb; padding:8px 10px; text-align:left; font-size:11px; text-transform:uppercase; letter-spacing:.04em; }
  table.items td { padding:8px 10px; border-bottom:1px solid #eee; }
  .num { text-align:right; }
  .totals { float:right; width:280px; }
  .totals table { width:100%; }
  .totals td { padding:5px 8px; }
  .totals td:last-child { text-align:right; }
  .totals .grand td { font-weight:700; border-top:2px solid #1a1a2e; font-size:15px; }
  .notes { margin-top:60px; font-size:12px; color:#555; }
  .notes strong { display:block; margin-bottom:4px; }
  .badge { display:inline-block; padding:3px 10px; border-radius:4px; font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:.06em; background:#dff0d8; color:#27592e; }
  .badge.overdue { background:#fde8e8; color:#a01010; }
  .badge.draft { background:#e8eaf6; color:#3949ab; }
  .clearfix::after { content:''; display:table; clear:both; }
</style>
</head>
<body>
<div class="header">
  <div>
    ${logoHtml}
    <div class="brand">${business.name}</div>
    <div style="margin-top:8px;color:#666;">${invoice.documentType}</div>
  </div>
  <table class="meta">
    <tr><th>Number</th><td>${invoice.invoiceNumber}</td></tr>
    <tr><th>Date</th><td>${invoice.createdAt.slice(0, 10)}</td></tr>
    ${invoice.dueDate ? `<tr><th>Due</th><td>${invoice.dueDate}</td></tr>` : ''}
    <tr><th>Status</th><td><span class="badge ${invoice.status.toLowerCase()}">${invoice.status}</span></td></tr>
  </table>
</div>

<h2>${invoice.documentType === 'INVOICE' ? 'Invoice' : invoice.documentType === 'QUOTE' ? 'Quotation' : 'Receipt'}</h2>

<table class="items">
  <thead>
    <tr>
      <th>Description</th>
      <th class="num">Qty</th>
      <th class="num">Unit Price</th>
      <th class="num">Discount</th>
      <th class="num">Total</th>
    </tr>
  </thead>
  <tbody>
    ${rows}
  </tbody>
</table>

<div class="clearfix">
  <div class="totals">
    <table>
      <tr><td>Subtotal</td><td>${fmt(invoice.subtotalCents)}</td></tr>
      ${invoice.taxBasisPoints > 0 ? `<tr><td>Tax (${taxPct}%)</td><td>${fmt(taxCents)}</td></tr>` : ''}
      ${invoice.discountCents > 0 ? `<tr><td>Discount</td><td>-${fmt(invoice.discountCents)}</td></tr>` : ''}
      <tr class="grand"><td>Total</td><td>${fmt(invoice.totalCents)}</td></tr>
    </table>
  </div>
</div>

${invoice.notes ? `<div class="notes"><strong>Notes</strong>${invoice.notes}</div>` : ''}
${invoice.terms ? `<div class="notes" style="margin-top:12px"><strong>Terms & Conditions</strong>${invoice.terms}</div>` : ''}
${invoice.footerText ? `<div class="notes" style="margin-top:12px;text-align:center;">${invoice.footerText}</div>` : ''}
</body>
</html>`;
  }
}
