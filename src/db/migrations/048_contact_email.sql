-- A CRM contact needs an email address before anything can email them.
--
-- WhatsApp does not expose one - it is a phone-number identity - so this can
-- only ever be entered by a person or imported from a real source. Nothing
-- derives or guesses it: no "firstname@company.com" construction, no
-- scraping. NULL means genuinely unknown, and the email automation treats it
-- as "cannot send" rather than falling back to anything.
ALTER TABLE crm_contacts
  ADD COLUMN email TEXT;

-- Finding everyone who can actually be emailed is a real, frequent query.
CREATE INDEX crm_contacts_email_idx ON crm_contacts (business_id) WHERE email IS NOT NULL AND deleted_at IS NULL;
