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

  recordFailure(reason: string): void {
    this.lastFailureReason = reason;
    if (this.state === 'HALF_OPEN') {
      // The probe attempt failed - stay open and reset the cooldown clock.
      this.state = 'OPEN';
      this.openedAt = Date.now();
      console.warn(`[CircuitBreaker:${this.name}] Probe failed, reopening circuit.`);
      return;
    }
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.config.failureThreshold) {
      this.state = 'OPEN';
      this.openedAt = Date.now();
      console.warn(
        `[CircuitBreaker:${this.name}] Opened after ${this.consecutiveFailures} consecutive failures: ${reason}`,
      );
    }
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

export const geminiCircuitBreaker = new CircuitBreaker('gemini');
