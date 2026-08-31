export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerConfig {
  failureThreshold: number;
  cooldownMs: number;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const DEFAULT_CONFIG: CircuitBreakerConfig = {
  failureThreshold: envInt('GEMINI_CIRCUIT_FAILURE_THRESHOLD', 3),
  cooldownMs: envInt('GEMINI_CIRCUIT_COOLDOWN_MS', 60_000),
};

/**
 * A minimal per-process circuit breaker for the Gemini reply call - not a
 * distributed/Redis-shared breaker. Each worker process trips
 * independently, which is the right granularity here: the point is to
 * stop one worker process wasting a full network timeout on every queued
 * message during a sustained outage, not to coordinate cluster-wide -
 * that would be real added complexity for a problem this cheap to just
 * let each process self-heal on its own cooldown.
 */
export class CircuitBreaker {
  private state: CircuitState = 'CLOSED';
  private consecutiveFailures = 0;
  private openedAt: number | null = null;
  private lastFailureReason: string | null = null;

  constructor(
    private readonly name: string,
    private readonly config: CircuitBreakerConfig = DEFAULT_CONFIG,
  ) {}

  /** Whether a real call should be attempted right now, transitioning OPEN -> HALF_OPEN once the cooldown has elapsed. */
  canAttempt(): boolean {
    if (this.state !== 'OPEN') return true;
    if (this.openedAt !== null && Date.now() - this.openedAt >= this.config.cooldownMs) {
      this.state = 'HALF_OPEN';
      return true;
    }
    return false;
  }

  recordSuccess(): void {
    if (this.state !== 'CLOSED') console.log(`[CircuitBreaker:${this.name}] Recovered - closing circuit.`);
    this.state = 'CLOSED';
    this.consecutiveFailures = 0;
    this.openedAt = null;
    this.lastFailureReason = null;
  }

  /**
   * @returns `justOpened` - true only on the transition into OPEN (a fresh
   * trip from CLOSED, or a failed HALF_OPEN probe reopening it) - never
   * true for a subsequent failure recorded while already OPEN. Callers
   * that want a one-time signal (e.g. an operator notification) should key
   * off this return value rather than the breaker's state alone, which
   * stays OPEN across every repeat failure.
   */
  recordFailure(reason: string): boolean {
    this.lastFailureReason = reason;
    if (this.state === 'HALF_OPEN') {
      // The probe attempt failed - stay open and reset the cooldown clock.
      this.state = 'OPEN';
      this.openedAt = Date.now();
      console.warn(`[CircuitBreaker:${this.name}] Probe failed, reopening circuit.`);
      return true;
    }
    const wasClosed = this.state === 'CLOSED';
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.config.failureThreshold) {
      this.state = 'OPEN';
      this.openedAt = Date.now();
      console.warn(
        `[CircuitBreaker:${this.name}] Opened after ${this.consecutiveFailures} consecutive failures: ${reason}`,
      );
      return wasClosed;
    }
    return false;
  }

  describeUnavailable(): string {
    return `circuit breaker open after ${this.consecutiveFailures} consecutive failure(s) (last: ${this.lastFailureReason ?? 'unknown'})`;
  }

  getState(): CircuitState {
    return this.state;
  }

  /** Test-only: force a clean CLOSED state between test cases. */
  reset(): void {
    this.state = 'CLOSED';
    this.consecutiveFailures = 0;
    this.openedAt = null;
    this.lastFailureReason = null;
  }
}

/**
 * Phase 3B: a second, independent breaker for the "will never recover
 * without a human" failure classes (auth/authz, provider/model-config -
 * see docs/PHASE_3A_AI_RELIABILITY_AUDIT_AND_PROPOSAL.md sections 2-4).
 * Unlike the per-business breaker below, nothing ever calls `canAttempt()`
 * on this instance - it does not gate whether a real call is attempted (a
 * misconfigured key must still surface honestly on every real call, never
 * be silently skipped). Its only purpose is to gate a one-time operator
 * notification: `failureThreshold: 1` means the very first classified
 * failure trips it, and `recordFailure`'s `justOpened` return value fires
 * exactly once per incident - repeat failures while still open do not
 * re-notify, and a later real success (recordSuccess) closes it so a
 * genuinely new incident can notify again.
 */
const DEFAULT_CONFIG_BREAKER_CONFIG: CircuitBreakerConfig = {
  failureThreshold: envInt('GEMINI_CONFIG_FAILURE_THRESHOLD', 1),
  cooldownMs: envInt('GEMINI_CONFIG_NOTIFY_COOLDOWN_MS', 3_600_000),
};

const geminiBreakersByBusiness = new Map<string, CircuitBreaker>();
const geminiConfigBreakersByBusiness = new Map<string, CircuitBreaker>();

/**
 * Scoped per business, never shared across the process. This app runs
 * many businesses' WhatsApp AI replies through one Node process - a single
 * process-wide breaker used to mean one business's Gemini failures (a
 * quota exhaustion, a transient outage) silently made every OTHER
 * business's very next message skip Gemini too, fast-forwarding it
 * straight to the slower fallback chain (or "unavailable" -> human
 * handoff) for a failure that had nothing to do with it. Each business
 * now trips and recovers its own circuit independently, exactly like its
 * own conversations are otherwise fully isolated from every other
 * business's.
 */
export function getGeminiCircuitBreaker(businessId: string): CircuitBreaker {
  let breaker = geminiBreakersByBusiness.get(businessId);
  if (!breaker) {
    breaker = new CircuitBreaker(`gemini:${businessId}`);
    geminiBreakersByBusiness.set(businessId, breaker);
  }
  return breaker;
}

export function getGeminiConfigCircuitBreaker(businessId: string): CircuitBreaker {
  let breaker = geminiConfigBreakersByBusiness.get(businessId);
  if (!breaker) {
    breaker = new CircuitBreaker(`gemini-config:${businessId}`, DEFAULT_CONFIG_BREAKER_CONFIG);
    geminiConfigBreakersByBusiness.set(businessId, breaker);
  }
  return breaker;
}

/** Test-only: drops every per-business breaker instance between test cases. */
export function resetAllGeminiCircuitBreakers(): void {
  geminiBreakersByBusiness.clear();
  geminiConfigBreakersByBusiness.clear();
}
