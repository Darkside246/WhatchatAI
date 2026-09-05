-- Real business contact fields for the invoice header block (address,
-- phone) - motto (migration 983) already covers "slogan", nothing new
-- needed there. And a real, user-settable issue date for invoices,
-- separate from created_at (an audit timestamp, not a document-stated
-- date) - backfilled from each existing row's own created_at so nothing
-- retroactively changes for already-issued documents.
ALTER TABLE businesses ADD COLUMN address TEXT;
ALTER TABLE businesses ADD COLUMN phone TEXT;

ALTER TABLE invoices ADD COLUMN issue_date DATE;
UPDATE invoices SET issue_date = created_at::date WHERE issue_date IS NULL;
ALTER TABLE invoices ALTER COLUMN issue_date SET NOT NULL;
ALTER TABLE invoices ALTER COLUMN issue_date SET DEFAULT CURRENT_DATE;
