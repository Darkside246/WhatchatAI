-- The credential a Fleet cell presents when it calls INTO WhatchatAI's
-- own Tool Gateway adapter endpoint - the opposite direction from the
-- Fleet Gateway token (which WhatchatAI would use to call OUT to a
-- cell's own Gateway, and is deliberately not stored anywhere per
-- migration 061's own comment). Only ever verified by equality, never
-- needs to be read back as plaintext, so it follows the exact same
-- hash-only pattern this codebase already uses for session tokens
-- (sessionTokenService.ts) rather than reversible envelope encryption -
-- there is nothing to decrypt back to.
ALTER TABLE openclaw_fleet_cells ADD COLUMN callback_token_hash TEXT UNIQUE;
