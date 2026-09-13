-- Tax as its own line, and a discount the till can actually give.
--
-- Neither existed. Prices were assumed tax-INCLUSIVE everywhere - the
-- receipt builder works the VAT back out of the total - which is right for
-- Barbados and impossible for a business that prices the other way. And
-- there was no discount concept at all: not on the till, not in the
-- resolver, not on the order. A cashier who wanted to take a dollar off had
-- to change the menu.
--
-- TAX. Two settings, because "what is the tax" is genuinely two questions:
-- how much, and is it already in the price on the board. A rate in basis
-- points rather than a percent so 17.5% is 1750 and not a float that drifts
-- by a cent on the hundredth order. NULL rate means a business that has not
-- said, and nothing is invented for it: no tax line is shown and every
-- existing total stays exactly what it is today.
--
-- tax_inclusive defaults TRUE because that is what every price already
-- stored means. A migration that flipped the reading of existing prices
-- would silently add tax to every menu in the system.
--
-- DISCOUNTS. Stored on the order as an amount and a reason, never as a
-- changed price. Two reasons, both learned the hard way by everyone who
-- has built a till:
--
--   The books have to be able to show gross, discount and net separately.
--   A discount folded into the line price is revenue that vanished with no
--   record of who gave it away or why.
--
--   The kitchen ticket must never show it. What the cook needs is the food.
--
-- Amount, not percent, as the stored truth: a percentage of a total that is
-- later corrected is a different number, and the one somebody agreed to is
-- the amount. A percent typed at the till is turned into an amount there
-- and then.

ALTER TABLE food_settings
  ADD COLUMN IF NOT EXISTS tax_rate_basis_points INTEGER;

ALTER TABLE food_settings
  DROP CONSTRAINT IF EXISTS food_settings_tax_rate_check;
ALTER TABLE food_settings
  ADD CONSTRAINT food_settings_tax_rate_check
  CHECK (tax_rate_basis_points IS NULL OR (tax_rate_basis_points >= 0 AND tax_rate_basis_points <= 10000));

ALTER TABLE food_settings
  ADD COLUMN IF NOT EXISTS tax_inclusive BOOLEAN NOT NULL DEFAULT TRUE;

/* What was taken off this order, and why. Never negative, and never larger
   than the order it is on - both checked again in the resolver, because a
   constraint that lives in only one of the two places is one somebody will
   eventually route around. */
ALTER TABLE food_orders
  ADD COLUMN IF NOT EXISTS discount_cents INTEGER NOT NULL DEFAULT 0;

ALTER TABLE food_orders
  DROP CONSTRAINT IF EXISTS food_orders_discount_cents_check;
ALTER TABLE food_orders
  ADD CONSTRAINT food_orders_discount_cents_check CHECK (discount_cents >= 0);

/* Free text in the operator's own words - "staff meal", "sorry about the
   wait". The books show it beside the money, so an owner reading a week of
   discounts can see what their shop actually gave away. */
ALTER TABLE food_orders
  ADD COLUMN IF NOT EXISTS discount_reason TEXT;

/* tax_cents is NOT new - migration 1032 created it, and it has been 0 on
   every order ever taken because nothing in the system ever worked tax out.
   The column was right and the arithmetic behind it did not exist. This
   only adds the constraint; what fills it is orderTotals.ts.

   Frozen at the moment the order is taken, never recomputed from settings
   later: a rate changed in April must not silently rewrite March's books. */

ALTER TABLE food_orders
  DROP CONSTRAINT IF EXISTS food_orders_tax_cents_check;
ALTER TABLE food_orders
  ADD CONSTRAINT food_orders_tax_cents_check CHECK (tax_cents >= 0);
