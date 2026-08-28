-- Business documents: invoices, quotes, and receipts.
-- document_type distinguishes the three; same schema, same approval flow.
-- All monetary amounts in the smallest currency unit (cents/pence).
-- tax_basis_points: 1750 = 17.50%.

CREATE TABLE invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES crm_contacts(id) ON DELETE SET NULL,
  property_id UUID REFERENCES property_properties(id) ON DELETE SET NULL,

  document_type TEXT NOT NULL DEFAULT 'INVOICE'
    CHECK (document_type IN ('INVOICE', 'QUOTE', 'RECEIPT')),

  status TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN (
      'DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SENT',
      'PAID', 'OVERDUE', 'CANCELLED', 'VOID'
    )),

  invoice_number TEXT NOT NULL,
  currency_code CHAR(3) NOT NULL DEFAULT 'BBD',

  -- Line-item totals are stored on the invoice for fast reads.
  -- They must be recomputed by the service whenever line items change.
  subtotal_cents BIGINT NOT NULL DEFAULT 0,
  tax_basis_points INT NOT NULL DEFAULT 0,   -- e.g. 1750 = 17.50 %
  discount_cents BIGINT NOT NULL DEFAULT 0,
  total_cents BIGINT NOT NULL DEFAULT 0,

  due_date DATE,
  notes TEXT,
  terms TEXT,
  footer_text TEXT,

  -- AI drafting metadata
  ai_generated BOOLEAN NOT NULL DEFAULT FALSE,
  ai_conversation_id UUID,  -- whatsapp_chats.id that triggered the draft

  -- Timestamps for status transitions
  approved_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  paid_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (business_id, invoice_number)
);

CREATE INDEX invoices_business_status_idx ON invoices (business_id, status);
CREATE INDEX invoices_business_contact_idx ON invoices (business_id, contact_id)
  WHERE contact_id IS NOT NULL;

-- Line items for each invoice/quote/receipt.
CREATE TABLE invoice_line_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  sort_order INT NOT NULL DEFAULT 0,

  description TEXT NOT NULL,
  quantity NUMERIC(12, 4) NOT NULL DEFAULT 1,
  unit_price_cents BIGINT NOT NULL,
  discount_basis_points INT NOT NULL DEFAULT 0,  -- per-line discount
  total_cents BIGINT NOT NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX invoice_line_items_invoice_idx ON invoice_line_items (invoice_id);

-- Per-business invoice number sequence so numbers are tenant-scoped and gapless.
CREATE TABLE invoice_number_sequences (
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  prefix TEXT NOT NULL,   -- e.g. 'INV' or 'QUO' or 'REC'
  last_sequence INT NOT NULL DEFAULT 0,
  PRIMARY KEY (business_id, prefix)
);
