import { createHash, randomBytes } from 'node:crypto';

/**
 * The credential a cell presents (as a Bearer token) when calling
 * into AURA's own OpenClaw Tool Gateway adapter endpoint. Same
 * generate/hash shape as sessionTokenService.ts (32 random bytes, SHA-256
 * for the stored lookup value) - a deliberate mirror, not a shared import,
 * since this is a different credential for a different direction of
 * trust and the two should stay independently reviewable.
 */
export function generateCallbackToken(): string {
  return randomBytes(32).toString('hex');
}

/** What's actually stored in openclaw_cells.callback_token_hash - a lookup can't work backward to the raw token. */
export function hashCallbackToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
