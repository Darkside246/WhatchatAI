-- A condiment that comes with the dish, and costs when they want more.
--
-- An option had one price and one meaning: every one charged, or every one
-- free. A real kitchen offers the same thing both ways at once - the
-- ketchup that comes with the chips, and the third pot that does not - and
-- there was no way to say so. The extra went out unpaid, or the included
-- one was charged for.
--
-- free_quantity is how many come at no charge. Everything past it is
-- charged at price_delta_cents, which keeps its existing meaning exactly:
-- with the default of 0, every option in every menu behaves precisely as it
-- did before this migration. Nothing that exists changes price.
--
-- A count rather than a boolean, because "how many are included" is a real
-- number an owner sets, not a yes or no: two sauces with a large, a third
-- costs. The toggle on the menu screen is a view of this column (on = 1,
-- off = 0), so there is no second piece of state that can disagree with it.

ALTER TABLE food_modifier_options
  ADD COLUMN IF NOT EXISTS free_quantity INTEGER NOT NULL DEFAULT 0;

/* Negative would be a discount nobody entered. The application floors this
   as well - see modifierPricing.ts - because a constraint that only exists
   in one of the two places is a constraint somebody will route around. */
ALTER TABLE food_modifier_options
  DROP CONSTRAINT IF EXISTS food_modifier_options_free_quantity_check;
ALTER TABLE food_modifier_options
  ADD CONSTRAINT food_modifier_options_free_quantity_check CHECK (free_quantity >= 0);
