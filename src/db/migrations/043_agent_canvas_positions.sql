-- Phase F3: persist where the operator actually placed each agent on the
-- org canvas. These are real, user-chosen coordinates - not a layout the app
-- computes and pretends the user arranged. NULL means "never placed", which
-- the UI lays out on a default grid until the operator drags it somewhere.
ALTER TABLE ai_agents
  ADD COLUMN canvas_x DOUBLE PRECISION,
  ADD COLUMN canvas_y DOUBLE PRECISION;
