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

  it('deletes a real CANCELLED invoice - never sent to a customer, same reasoning as DRAFT', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const invoice = await draftInvoice(businessId);
    await svc.submitForApproval(businessId, invoice.id);
    await svc.approve(businessId, invoice.id);
    await svc.cancel(businessId, invoice.id);

    const deleted = await svc.remove(businessId, invoice.id);
    expect(deleted).toBe(true);
    expect(await svc.get(businessId, invoice.id)).toBeNull();
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

  /**
   * The compliance gap these pin: RenderInput carried no customer at all, so
   * no invoice, quote or receipt this system produced ever named the party
   * being billed. A document with no Bill To is not a valid tax invoice.
   */
  describe('Bill To', () => {
    const business = { name: 'Acme Plumbing', brandColor: null, logoDataUrl: null };

    it('names the party being billed on every template, not just one', async () => {
      await resetDatabase();
      const businessId = await createTestBusiness();
      const invoice = await draftInvoice(businessId);
      const { invoice: full, lineItems } = (await svc.get(businessId, invoice.id))!;

      // All three, because a shared block is only worth having if every
      // template really uses it - three hand-written copies is exactly how
      // one ends up compliant and another silently is not.
      for (const templateId of ['classic', 'modern', 'minimal'] as const) {
        const html = svc.renderHtml(
          full,
          lineItems,
          business,
          { templateId, colors: {} },
          { name: 'Lashley Construction Ltd.', address: '12 Broad St, Bridgetown', email: 'accounts@lashley.bb' },
        );
        expect(html, templateId).toContain('Bill To');
        expect(html, templateId).toContain('Lashley Construction Ltd.');
        expect(html, templateId).toContain('12 Broad St, Bridgetown');
      }
    });

    it('renders no Bill To block at all when there is genuinely no customer', async () => {
      await resetDatabase();
      const businessId = await createTestBusiness();
      const invoice = await draftInvoice(businessId);
      const { invoice: full, lineItems } = (await svc.get(businessId, invoice.id))!;

      // An empty heading over blank space reads as a rendering fault; no
      // block is the honest representation of "nobody chosen yet".
      expect(svc.renderHtml(full, lineItems, business)).not.toContain('Bill To');
    });

    it('escapes a customer name containing HTML rather than letting it into the document', async () => {
      await resetDatabase();
      const businessId = await createTestBusiness();
      const invoice = await draftInvoice(businessId);
      const { invoice: full, lineItems } = (await svc.get(businessId, invoice.id))!;

      const html = svc.renderHtml(full, lineItems, business, undefined, {
        name: '<script>alert(1)</script>',
        address: null,
      });
      expect(html).not.toContain('<script>alert(1)</script>');
      expect(html).toContain('&lt;script&gt;');
    });
  });

  describe('document labelling and tax identity', () => {
    const business = { name: 'Acme Plumbing', brandColor: null, logoDataUrl: null };

    it('titles a document that actually charges tax a "Tax Invoice"', async () => {
      await resetDatabase();
      const businessId = await createTestBusiness();
      const invoice = await draftInvoice(businessId);
      const { invoice: full, lineItems } = (await svc.get(businessId, invoice.id))!;

      // That exact wording is part of what makes a VAT document one a
      // registered customer can claim against.
      const html = svc.renderHtml({ ...full, taxBasisPoints: 1750 }, lineItems, business);
      expect(html).toContain('Tax Invoice');
    });

    it('does NOT call a zero-tax document a tax invoice', async () => {
      await resetDatabase();
      const businessId = await createTestBusiness();
      const invoice = await draftInvoice(businessId);
      const { invoice: full, lineItems } = (await svc.get(businessId, invoice.id))!;

      // Conditioned on tax genuinely being charged - titling a zero-tax
      // document a tax invoice is its own misstatement.
      const html = svc.renderHtml({ ...full, taxBasisPoints: 0 }, lineItems, business);
      expect(html).not.toContain('Tax Invoice');
      expect(html).toContain('Invoice');
    });

    it('prints the tax registration number under the label the business chose', async () => {
      await resetDatabase();
      const businessId = await createTestBusiness();
      const invoice = await draftInvoice(businessId);
      const { invoice: full, lineItems } = (await svc.get(businessId, invoice.id))!;

      const html = svc.renderHtml({ ...full, taxBasisPoints: 1750 }, lineItems, {
        ...business,
        taxRegistrationNumber: '40012345',
        // Free text, because the right word differs by country - an enum
        // would be wrong somewhere.
        taxRegistrationLabel: 'VAT No.',
        paymentInstructions: 'Bank transfer to Acme Plumbing, RBC 123456',
      });

      expect(html).toContain('VAT No.');
      expect(html).toContain('40012345');
      expect(html).toContain('How to pay');
      expect(html).toContain('RBC 123456');
    });

    it('prints no registration line when the business has not supplied one', async () => {
      await resetDatabase();
      const businessId = await createTestBusiness();
      const invoice = await draftInvoice(businessId);
      const { invoice: full, lineItems } = (await svc.get(businessId, invoice.id))!;

      // Stating a number the business does not have would be worse than
      // stating none.
      const html = svc.renderHtml(full, lineItems, business);
      expect(html).not.toContain('Tax Reg. No.');
      expect(html).not.toContain('How to pay');
    });
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
