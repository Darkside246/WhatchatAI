-- National ID is an alias too.
--
-- The Central Bank's description of sending money lists the recipient's
-- phone number, email address OR national ID as the identifiers a sender
-- can use in place of banking details. The first version of this column
-- allowed only email, mobile, nickname and account number.
--
-- A separate migration rather than an edit to 1038, because 1038 has
-- already been applied - rewriting an applied migration leaves every
-- database that ran it disagreeing with the file that describes it.
ALTER TABLE food_payment_methods
  DROP CONSTRAINT IF EXISTS food_payment_methods_alias_kind_check;

ALTER TABLE food_payment_methods
  ADD CONSTRAINT food_payment_methods_alias_kind_check
  CHECK (alias_kind IS NULL OR alias_kind IN ('EMAIL', 'MOBILE', 'NICKNAME', 'NATIONAL_ID', 'ACCOUNT_NUMBER'));
