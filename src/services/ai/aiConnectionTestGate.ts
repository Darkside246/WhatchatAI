/**
 * The real rate-limit math behind POST /api/workspace/ai/test-connection
 * (server/index.ts) - pulled into its own pure function so the 15-minute
 * boundary can be unit-tested directly, without spinning up the real
 * Express app (this codebase has no supertest-style HTTP test harness;
 * everything is tested at the service/repository layer instead).
 */
export const AI_TEST_CONNECTION_COOLDOWN_MS = 15 * 60 * 1000;

export type AiConnectionTestGateResult = { allowed: true } | { allowed: false; retryAfterSeconds: number };

export function checkAiConnectionTestGate(lastTestedAt: Date | null, now: Date = new Date()): AiConnectionTestGateResult {
  if (!lastTestedAt) return { allowed: true };
  const elapsedMs = now.getTime() - lastTestedAt.getTime();
  if (elapsedMs >= AI_TEST_CONNECTION_COOLDOWN_MS) return { allowed: true };
  return { allowed: false, retryAfterSeconds: Math.ceil((AI_TEST_CONNECTION_COOLDOWN_MS - elapsedMs) / 1000) };
}
