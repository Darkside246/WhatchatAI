import { describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { InvoiceService } from '../src/services/invoice/invoiceService.js';
import { createTestBusiness, resetDatabase } from './helpers.js';

const svc = new InvoiceService(pool);

async function draftInvoice(businessId: string) {
  const { invoice } = await svc.draft({
    businessId,
    lineItems: [{ description: 'Test item', quantity: 1, unitPriceCents: 1000 }],
  });
  return invoice;
}

describe('InvoiceService status transitions (real Postgres) - delete vs void vs cancel', () => {
  it('deletes a real DRAFT invoice, including its line items via cascade', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const invoice = await draftInvoice(businessId);

    const deleted = await svc.remove(businessId, invoice.id);
    expect(deleted).toBe(true);

    expect(await svc.get(businessId, invoice.id)).toBeNull();
    const { rows } = await pool.query('SELECT id FROM invoice_line_items WHERE invoice_id = $1', [invoice.id]);
    expect(rows).toHaveLength(0);
  });

  it('never deletes a non-DRAFT invoice, even if the caller tries', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const invoice = await draftInvoice(businessId);
    await svc.submitForApproval(businessId, invoice.id);

    const deleted = await svc.remove(businessId, invoice.id);
    expect(deleted).toBe(false);
    expect(await svc.get(businessId, invoice.id)).not.toBeNull(); // still there
  });

  it('cancels a pre-send invoice (DRAFT/PENDING_APPROVAL/APPROVED)', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const invoice = await draftInvoice(businessId);
    await svc.submitForApproval(businessId, invoice.id);
    await svc.approve(businessId, invoice.id);

    const cancelled = await svc.cancel(businessId, invoice.id);
    expect(cancelled?.status).toBe('CANCELLED');
  });

  it('refuses to cancel a SENT invoice - it must be voided instead', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const invoice = await draftInvoice(businessId);
    await svc.submitForApproval(businessId, invoice.id);
    await svc.approve(businessId, invoice.id);
    await svc.markSent(businessId, invoice.id);

    const result = await svc.cancel(businessId, invoice.id);
    expect(result).toBeNull();
    expect((await svc.get(businessId, invoice.id))?.invoice.status).toBe('SENT'); // untouched
  });

  it('voids a SENT invoice - the record and invoice number stay, never deleted', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const invoice = await draftInvoice(businessId);
    await svc.submitForApproval(businessId, invoice.id);
    await svc.approve(businessId, invoice.id);
    await svc.markSent(businessId, invoice.id);

    const voided = await svc.voidInvoice(businessId, invoice.id);
    expect(voided?.status).toBe('VOID');
    // Still a real row, same invoice number - never deleted.
    const stillThere = await svc.get(businessId, invoice.id);
    expect(stillThere?.invoice.invoiceNumber).toBe(invoice.invoiceNumber);
  });

  it('voids an OVERDUE invoice too', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const invoice = await draftInvoice(businessId);
    await pool.query(`UPDATE invoices SET status = 'OVERDUE' WHERE id = $1`, [invoice.id]);

    const voided = await svc.voidInvoice(businessId, invoice.id);
    expect(voided?.status).toBe('VOID');
  });

  it('refuses to void a DRAFT invoice - nothing has been sent yet, delete or cancel instead', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const invoice = await draftInvoice(businessId);

    const result = await svc.voidInvoice(businessId, invoice.id);
    expect(result).toBeNull();
  });

  it('never voids a PAID invoice - real money already moved', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const invoice = await draftInvoice(businessId);
    await svc.submitForApproval(businessId, invoice.id);
    await svc.approve(businessId, invoice.id);
    await svc.markSent(businessId, invoice.id);
    await svc.markPaid(businessId, invoice.id);

    const result = await svc.voidInvoice(businessId, invoice.id);
    expect(result).toBeNull();
    expect((await svc.get(businessId, invoice.id))?.invoice.status).toBe('PAID');
  });

  it('never cancels or deletes a PAID invoice', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const invoice = await draftInvoice(businessId);
    await svc.markPaid(businessId, invoice.id);

    expect(await svc.cancel(businessId, invoice.id)).toBeNull();
    expect(await svc.remove(businessId, invoice.id)).toBe(false);
  });
});

describe('InvoiceService.renderHtml - real business branding, never a raw id', () => {
  it('renders the real business name, brand color, and logo into the document', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const invoice = await draftInvoice(businessId);
    const { invoice: full, lineItems } = (await svc.get(businessId, invoice.id))!;

    const html = svc.renderHtml(full, lineItems, {
      name: 'Acme Plumbing',
      brandColor: '#ff6600',
      logoDataUrl: 'data:image/png;base64,AAAA',
    });

    expect(html).toContain('Acme Plumbing');
    expect(html).not.toContain(businessId); // the pre-fix bug: the raw business UUID leaking in as the "name"
    expect(html).toContain('color:#ff6600');
    expect(html).toContain('data:image/png;base64,AAAA');
  });

  it('falls back to the default blue and renders no logo tag when branding is unset', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const invoice = await draftInvoice(businessId);
    const { invoice: full, lineItems } = (await svc.get(businessId, invoice.id))!;

    const html = svc.renderHtml(full, lineItems, { name: 'Plain Co', brandColor: null, logoDataUrl: null });

    expect(html).toContain('color:#0a84ff');
    expect(html).not.toContain('<img');
  });
});
