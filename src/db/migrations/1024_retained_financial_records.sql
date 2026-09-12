-- Financial figures that outlive the account they came from.
--
-- THE CONFLICT THIS RESOLVES. Deleting a business cascades across every
-- tenant table (migration 939), invoices, subscriptions and payments
-- included. That is right for erasure and wrong for bookkeeping: tax
-- authorities generally require invoice records to be kept for years
-- regardless of whether the customer has since asked to be forgotten. The
-- two obligations are not actually in conflict, because they are about
-- different things - retention wants the FIGURES, erasure wants the PERSON
-- gone. So the figures are copied here first, without the person, and the
-- cascade then erases everything else exactly as before.
--
-- WHY A SNAPSHOT AND NOT AN EXEMPTION. The alternative was to spare these
-- tables from the cascade and delete every other table explicitly. That
-- inverts the safety property migration 939 was built for: with a cascade,
-- a table added next year is erased automatically, and with an explicit
-- list it is silently retained forever by whoever forgets to add it. The
-- cascade stays whole; this table takes a copy before it runs.
--
-- WHAT IS DELIBERATELY NOT HERE. No customer name, address, phone, email,
-- contact id or line-item description - a line item can read "Consultation
-- for Mrs Greaves, 14 Bay Street" and is prose, not an accounting figure.
-- No business name either: business_id is kept purely so one account's
-- records can be told apart from another's, and it points at a row that no
-- longer exists. Nothing here identifies a person, which is the whole
-- reason it is allowed to survive the deletion.

CREATE TABLE IF NOT EXISTS retained_financial_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Intentionally NOT a foreign key. The business row is gone by the time
  -- anyone reads this, and an FK would either block the deletion or delete
  -- these rows with it - the two failure modes this table exists to avoid.
  business_id uuid NOT NULL,

  -- 'invoice' | 'subscription' | 'token_topup' | 'memory_topup'
  record_type text NOT NULL,
  -- The original row's id, so a figure can still be reconciled against an
  -- external payment provider's own record of the same transaction.
  source_id uuid NOT NULL,

  -- The document's own reference where it had one (invoice_number). Null
  -- for records that never carried one.
  document_reference text,

  -- Money, as integer minor units, exactly as the source stored it. No
  -- conversion or rounding: a retained figure that does not match the
  -- document the customer was given is worse than no figure at all.
  currency_code char(3),
  subtotal_cents bigint,
  tax_cents bigint,
  total_cents bigint,

  -- What it was and when, in the source's own words.
  status text,
  issued_at timestamptz,
  paid_at timestamptz,

  retained_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT retained_financial_records_type_check
    CHECK (record_type IN ('invoice', 'subscription', 'token_topup', 'memory_topup')),
  -- One row per source record, so a retried or repeated purge cannot
  -- duplicate the accounts.
  CONSTRAINT retained_financial_records_source_key UNIQUE (record_type, source_id)
);

CREATE INDEX IF NOT EXISTS idx_retained_financial_records_business
  ON retained_financial_records (business_id, issued_at DESC);

-- No RLS and no tenant grant, on purpose. There is no tenant left to scope
-- this to - the business is deleted - and no application route reads it.
-- It is reachable only with direct database access, by whoever is answering
-- an auditor.
