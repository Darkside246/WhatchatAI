-- Real, per-business invoice/quote/receipt design settings - which of the
-- 3 built-in templates (classic/modern/minimal - see invoiceTemplates.ts)
-- and any block-level color overrides on top of it. Defaulted so every
-- existing business renders identically to before this column existed.
ALTER TABLE businesses ADD COLUMN invoice_customization JSONB NOT NULL DEFAULT '{"templateId":"classic","colors":{}}'::jsonb;
