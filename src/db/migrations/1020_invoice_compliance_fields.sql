-- What a document needs to be a real invoice rather than a nicely styled
-- statement of amounts.
--
-- THE GAP THIS CLOSES: the renderer was never given the customer at all.
-- invoices.contact_id has existed since 917, but RenderInput carried only
-- {invoice, lineItems, business, customization}, so no invoice, quote or
-- receipt this system has ever produced showed who it was addressed to. A
-- document with no "Bill To" is not a valid tax invoice in essentially any
-- jurisdiction, and a customer cannot use it to claim anything.
--
-- The fields below are the remaining ones a standard invoice states and
-- this schema had nowhere to put.
--
-- HONESTY: every one is nullable and every one is omitted from the rendered
-- document when empty. Nothing here is invented, defaulted to a placeholder,
-- or inferred - an invoice that states a tax registration number the
-- business does not have would be worse than one that states none.
--
-- NOT ENCRYPTED, deliberately and consistently: businesses.address/phone
-- (989) and crm_contacts.email/notes/manual_display_name are all plaintext
-- today, and neither repository uses EncryptionService. Encrypting only
-- billing_address while a contact's name and email sit in plaintext beside
-- it would give the appearance of protection without the substance. RLS
-- remains the real tenant boundary on both tables. (Whether crm_contacts
-- PII should be encrypted at rest as a whole is a genuine question, but it
-- is a separate, table-wide decision - not one to half-make here.)

-- ── Business identity printed in the document header ────────────────────────

-- The registration number a tax authority requires on a tax invoice (VAT
-- number in Barbados and much of the Caribbean, TIN/GST/ABN elsewhere).
-- Free text, not validated to a format: the correct shape differs by
-- country, and rejecting a valid foreign number would be worse than
-- accepting whatever the business says its number is.
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS tax_registration_number TEXT;

-- The label for that number, so the document reads "VAT No." in Barbados
-- and "ABN" in Australia rather than a generic word that is wrong in most
-- places. Defaulted to NULL, not to "VAT": guessing the customer's tax
-- regime from nothing is exactly the kind of invented fact to avoid.
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS tax_registration_label TEXT;

-- Contact routes a customer needs to query or pay a document. Distinct from
-- the WhatsApp line the business operates on - an invoice is usually queried
-- by email even when the conversation happened over WhatsApp.
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS invoice_email TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS invoice_website TEXT;

-- How to actually pay: bank details, a payment link, "cash on delivery".
-- Its own field rather than folded into the existing free-text `terms`,
-- because payment instructions belong in a predictable place on the
-- document and terms are a different thing legally.
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS payment_instructions TEXT;

-- ── The customer the document is addressed to ───────────────────────────────

-- crm_contacts already carries a name (manual_display_name, plus the
-- WhatsApp-side name) and email, but no postal address - which is the one
-- field a Bill To block cannot do without.
ALTER TABLE crm_contacts ADD COLUMN IF NOT EXISTS billing_address TEXT;

-- The legal entity being billed, when that differs from the person in the
-- chat. Real and common: the conversation is with "Julian", the invoice is
-- addressed to "Lashley Construction Ltd." Without this the document either
-- names an individual for a company purchase, or the operator edits the
-- contact's own name and corrupts the CRM record to fix a document.
ALTER TABLE crm_contacts ADD COLUMN IF NOT EXISTS billing_name TEXT;
