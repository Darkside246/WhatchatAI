-- Section 75-91 (data privacy/retention): real, significant bug found
-- while building the account-deletion UI - customer_memory (migration
-- 959) was created AFTER migration 939's "fix every table blocking a
-- real business purge" sweep, and was simply never included in it.
-- Verified against the live schema: it is the ONLY table in the entire
-- database referencing businesses(id) without ON DELETE CASCADE (every
-- other table, including its own sibling customer_identities, already
-- cascades correctly). Left as-is, any business with real customer
-- memory (a routine, expected occurrence - the AI records this
-- automatically for a returning customer) would hit a foreign key
-- violation on purgeBusiness()'s `DELETE FROM businesses`, silently
-- fail the sweep every single time it retries, and never actually be
-- deleted - directly undermining the account-deletion feature.
ALTER TABLE customer_memory
  DROP CONSTRAINT customer_memory_business_id_fkey,
  ADD CONSTRAINT customer_memory_business_id_fkey FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE;
