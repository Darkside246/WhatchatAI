import type { Queryable } from './types.js';

export type InvoiceRecord = {
  id: string;
  businessId: string;
  contactId: string | null;
  propertyId: string | null;
  documentType: 'INVOICE' | 'QUOTE' | 'RECEIPT';
  status: 'DRAFT' | 'PENDING_APPROVAL' | 'APPROVED' | 'SENT' | 'PAID' | 'OVERDUE' | 'CANCELLED' | 'VOID';
  invoiceNumber: string;
  currencyCode: string;
  subtotalCents: number;
  taxBasisPoints: number;
  discountCents: number;
  totalCents: number;
  dueDate: string | null;
  notes: string | null;
  terms: string | null;
  footerText: string | null;
  aiGenerated: boolean;
  aiConversationId: string | null;
  approvedAt: string | null;
  sentAt: string | null;
  paidAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type InvoiceLineItemRecord = {
  id: string;
  invoiceId: string;
  businessId: string;
  sortOrder: number;
  description: string;
  quantity: string;
  unitPriceCents: number;
  discountBasisPoints: number;
  totalCents: number;
  createdAt: string;
  updatedAt: string;
};

export type CreateInvoiceInput = {
  businessId: string;
  contactId?: string | undefined;
  propertyId?: string | undefined;
  documentType?: 'INVOICE' | 'QUOTE' | 'RECEIPT';
  currencyCode?: string;
  taxBasisPoints?: number;
  dueDate?: string | undefined;
  notes?: string | undefined;
  terms?: string | undefined;
  footerText?: string | undefined;
  aiGenerated?: boolean;
  aiConversationId?: string | undefined;
  lineItems: Array<{
    description: string;
    quantity: number;
    unitPriceCents: number;
    discountBasisPoints?: number;
    sortOrder?: number;
  }>;
};

const INVOICE_COLS = `
  id, business_id AS "businessId", contact_id AS "contactId",
  property_id AS "propertyId", document_type AS "documentType", status,
  invoice_number AS "invoiceNumber", currency_code AS "currencyCode",
  subtotal_cents AS "subtotalCents", tax_basis_points AS "taxBasisPoints",
  discount_cents AS "discountCents", total_cents AS "totalCents",
  due_date AS "dueDate", notes, terms, footer_text AS "footerText",
  ai_generated AS "aiGenerated", ai_conversation_id AS "aiConversationId",
  approved_at AS "approvedAt", sent_at AS "sentAt", paid_at AS "paidAt",
  created_at AS "createdAt", updated_at AS "updatedAt"
`.trim();

const LINE_COLS = `
  id, invoice_id AS "invoiceId", business_id AS "businessId",
  sort_order AS "sortOrder", description, quantity::text AS quantity,
  unit_price_cents AS "unitPriceCents", discount_basis_points AS "discountBasisPoints",
  total_cents AS "totalCents", created_at AS "createdAt", updated_at AS "updatedAt"
`.trim();

function computeLineTotalCents(unitPriceCents: number, quantity: number, discountBasisPoints: number): number {
  const gross = Math.round(unitPriceCents * quantity);
  const discount = Math.round(gross * discountBasisPoints / 10000);
  return gross - discount;
}

function computeInvoiceTotals(
  lineItems: Array<{ unitPriceCents: number; quantity: number; discountBasisPoints: number }>,
  taxBasisPoints: number,
): { subtotalCents: number; discountCents: number; totalCents: number } {
  const subtotalCents = lineItems.reduce((acc, li) => acc + computeLineTotalCents(li.unitPriceCents, li.quantity, li.discountBasisPoints), 0);
  const discountCents = 0;
  const taxCents = Math.round(subtotalCents * taxBasisPoints / 10000);
  return { subtotalCents, discountCents, totalCents: subtotalCents + taxCents };
}

export class InvoiceRepository {
  constructor(private readonly db: Queryable) {}

  private async nextInvoiceNumber(businessId: string, prefix: string): Promise<string> {
    const { rows } = await this.db.query<{ seq: string }>(
      `INSERT INTO invoice_number_sequences (business_id, prefix, last_sequence)
       VALUES ($1, $2, 1)
       ON CONFLICT (business_id, prefix) DO UPDATE
         SET last_sequence = invoice_number_sequences.last_sequence + 1
       RETURNING last_sequence::text AS seq`,
      [businessId, prefix],
    );
    const seq = rows[0]?.seq ?? '1';
    const yearMonth = new Date().toISOString().slice(0, 7).replace('-', '');
    return `${prefix}-${yearMonth}-${seq.padStart(4, '0')}`;
  }

  async create(input: CreateInvoiceInput): Promise<{ invoice: InvoiceRecord; lineItems: InvoiceLineItemRecord[] }> {
    const docType = input.documentType ?? 'INVOICE';
    const prefix = docType === 'INVOICE' ? 'INV' : docType === 'QUOTE' ? 'QUO' : 'REC';
    const taxBp = input.taxBasisPoints ?? 0;

    const enrichedLines = input.lineItems.map((li) => ({
      ...li,
      discountBasisPoints: li.discountBasisPoints ?? 0,
      sortOrder: li.sortOrder ?? 0,
    }));

    const totals = computeInvoiceTotals(enrichedLines, taxBp);
    const invoiceNumber = await this.nextInvoiceNumber(input.businessId, prefix);

    const { rows: [inv] } = await this.db.query<InvoiceRecord>(
      `INSERT INTO invoices
         (business_id, contact_id, property_id, document_type, invoice_number,
          currency_code, subtotal_cents, tax_basis_points, discount_cents, total_cents,
          due_date, notes, terms, footer_text, ai_generated, ai_conversation_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       RETURNING ${INVOICE_COLS}`,
      [
        input.businessId, input.contactId ?? null, input.propertyId ?? null, docType,
        invoiceNumber, input.currencyCode ?? 'BBD',
        totals.subtotalCents, taxBp, totals.discountCents, totals.totalCents,
        input.dueDate ?? null, input.notes ?? null, input.terms ?? null, input.footerText ?? null,
        input.aiGenerated ?? false, input.aiConversationId ?? null,
      ],
    );
    if (!inv) throw new Error('invoice insert returned no row');

    const lineItems: InvoiceLineItemRecord[] = [];
    for (const li of enrichedLines) {
      const totalCents = computeLineTotalCents(li.unitPriceCents, li.quantity, li.discountBasisPoints);
      const { rows: [row] } = await this.db.query<InvoiceLineItemRecord>(
        `INSERT INTO invoice_line_items
           (invoice_id, business_id, sort_order, description, quantity,
            unit_price_cents, discount_basis_points, total_cents)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING ${LINE_COLS}`,
        [inv.id, input.businessId, li.sortOrder, li.description, li.quantity,
         li.unitPriceCents, li.discountBasisPoints, totalCents],
      );
      if (row) lineItems.push(row);
    }

    return { invoice: inv, lineItems };
  }

  async findById(businessId: string, invoiceId: string): Promise<InvoiceRecord | null> {
    const { rows } = await this.db.query<InvoiceRecord>(
      `SELECT ${INVOICE_COLS} FROM invoices WHERE business_id = $1 AND id = $2`,
      [businessId, invoiceId],
    );
    return rows[0] ?? null;
  }

  async list(businessId: string, opts?: { status?: string; documentType?: string; limit?: number; offset?: number }): Promise<InvoiceRecord[]> {
    const params: unknown[] = [businessId];
    const filters: string[] = ['business_id = $1'];
    if (opts?.status) { params.push(opts.status); filters.push(`status = $${params.length}`); }
    if (opts?.documentType) { params.push(opts.documentType); filters.push(`document_type = $${params.length}`); }
    params.push(opts?.limit ?? 50);
    params.push(opts?.offset ?? 0);
    const { rows } = await this.db.query<InvoiceRecord>(
      `SELECT ${INVOICE_COLS} FROM invoices WHERE ${filters.join(' AND ')} ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return rows;
  }

  async listLineItems(businessId: string, invoiceId: string): Promise<InvoiceLineItemRecord[]> {
    const { rows } = await this.db.query<InvoiceLineItemRecord>(
      `SELECT ${LINE_COLS} FROM invoice_line_items WHERE business_id = $1 AND invoice_id = $2 ORDER BY sort_order ASC`,
      [businessId, invoiceId],
    );
    return rows;
  }

  async updateStatus(
    businessId: string,
    invoiceId: string,
    status: InvoiceRecord['status'],
  ): Promise<InvoiceRecord | null> {
    const nowField = status === 'APPROVED' ? ', approved_at = NOW()' : status === 'SENT' ? ', sent_at = NOW()' : status === 'PAID' ? ', paid_at = NOW()' : '';
    const { rows } = await this.db.query<InvoiceRecord>(
      `UPDATE invoices SET status = $3, updated_at = NOW()${nowField} WHERE business_id = $1 AND id = $2 RETURNING ${INVOICE_COLS}`,
      [businessId, invoiceId, status],
    );
    return rows[0] ?? null;
  }

  /** Hard delete - line items cascade via their own ON DELETE CASCADE FK. Caller (InvoiceService.remove) is the one that enforces "DRAFT only", not this method - mirrors this repository's existing convention of raw DB ops with business rules kept at the service layer. */
  async delete(businessId: string, invoiceId: string): Promise<boolean> {
    const { rowCount } = await this.db.query('DELETE FROM invoices WHERE business_id = $1 AND id = $2', [businessId, invoiceId]);
    return (rowCount ?? 0) > 0;
  }

  async updateDetails(
    businessId: string,
    invoiceId: string,
    patch: Partial<Pick<InvoiceRecord, 'notes' | 'terms' | 'footerText' | 'dueDate' | 'taxBasisPoints' | 'currencyCode'>>,
  ): Promise<InvoiceRecord | null> {
    const sets: string[] = ['updated_at = NOW()'];
    const params: unknown[] = [businessId, invoiceId];
    if (patch.notes !== undefined) { params.push(patch.notes); sets.push(`notes = $${params.length}`); }
    if (patch.terms !== undefined) { params.push(patch.terms); sets.push(`terms = $${params.length}`); }
    if (patch.footerText !== undefined) { params.push(patch.footerText); sets.push(`footer_text = $${params.length}`); }
    if (patch.dueDate !== undefined) { params.push(patch.dueDate); sets.push(`due_date = $${params.length}`); }
    if (patch.taxBasisPoints !== undefined) { params.push(patch.taxBasisPoints); sets.push(`tax_basis_points = $${params.length}`); }
    if (patch.currencyCode !== undefined) { params.push(patch.currencyCode); sets.push(`currency_code = $${params.length}`); }
    const { rows } = await this.db.query<InvoiceRecord>(
      `UPDATE invoices SET ${sets.join(', ')} WHERE business_id = $1 AND id = $2 RETURNING ${INVOICE_COLS}`,
      params,
    );
    return rows[0] ?? null;
  }
}
