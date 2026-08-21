-- Without a real timezone, the AI reply pipeline has no honest way to know
-- whether "now" falls inside the opening hours an operator wrote in free
-- text (e.g. "open Mon-Fri 9-5") - the server's own clock is UTC and tells
-- you nothing about where the business actually is. Defaults to UTC (safe -
-- worse than wrong-timezone-but-silent is at least visibly generic) until
-- the operator sets their real one in Settings.
ALTER TABLE businesses
  ADD COLUMN timezone TEXT NOT NULL DEFAULT 'UTC';
