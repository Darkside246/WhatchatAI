import { describe, expect, it, vi } from 'vitest';
import { CircuitBreaker } from '../src/services/aiCircuitBreaker.js';

const FAST_CONFIG = { failureThreshold: 3, cooldownMs: 50 };

describe('CircuitBreaker (state machine only - no network involved)', () => {
  it('starts CLOSED and allows attempts', () => {
    const breaker = new CircuitBreaker('test', FAST_CONFIG);
    expect(breaker.getState()).toBe('CLOSED');
    expect(breaker.canAttempt()).toBe(true);
  });

  it('stays CLOSED below the failure threshold', () => {
    const breaker = new CircuitBreaker('test', FAST_CONFIG);
    breaker.recordFailure('boom');
    breaker.recordFailure('boom');
    expect(breaker.getState()).toBe('CLOSED');
    expect(breaker.canAttempt()).toBe(true);
  });

  it('opens after reaching the failure threshold, and stops allowing attempts', () => {
    const breaker = new CircuitBreaker('test', FAST_CONFIG);
    breaker.recordFailure('boom 1');
    breaker.recordFailure('boom 2');
    breaker.recordFailure('boom 3');
    expect(breaker.getState()).toBe('OPEN');
    expect(breaker.canAttempt()).toBe(false);
  });

  it('describes the outage honestly, including the last real failure reason', () => {
    const breaker = new CircuitBreaker('test', FAST_CONFIG);
    breaker.recordFailure('quota exceeded');
    breaker.recordFailure('quota exceeded');
    breaker.recordFailure('quota exceeded');
    expect(breaker.describeUnavailable()).toContain('3');
    expect(breaker.describeUnavailable()).toContain('quota exceeded');
  });

  it('transitions OPEN -> HALF_OPEN after the cooldown elapses, allowing exactly one probe', async () => {
    const breaker = new CircuitBreaker('test', FAST_CONFIG);
    breaker.recordFailure('boom');
    breaker.recordFailure('boom');
    breaker.recordFailure('boom');
    expect(breaker.canAttempt()).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, FAST_CONFIG.cooldownMs + 10));

    expect(breaker.canAttempt()).toBe(true);
    expect(breaker.getState()).toBe('HALF_OPEN');
  });

  it('a successful probe closes the circuit and resets the failure count', async () => {
    const breaker = new CircuitBreaker('test', FAST_CONFIG);
    breaker.recordFailure('boom');
    breaker.recordFailure('boom');
    breaker.recordFailure('boom');
    await new Promise((resolve) => setTimeout(resolve, FAST_CONFIG.cooldownMs + 10));
    breaker.canAttempt(); // transitions to HALF_OPEN

    breaker.recordSuccess();

    expect(breaker.getState()).toBe('CLOSED');
    expect(breaker.canAttempt()).toBe(true);

    // Confirms the failure count really reset - it should take a full
    // fresh run of 3 failures to re-open, not just 1.
    breaker.recordFailure('boom again');
    expect(breaker.getState()).toBe('CLOSED');
  });

  it('a failed probe reopens the circuit and resets the cooldown clock', async () => {
    vi.useFakeTimers();
    try {
      const breaker = new CircuitBreaker('test', FAST_CONFIG);
      breaker.recordFailure('boom');
      breaker.recordFailure('boom');
      breaker.recordFailure('boom');

      vi.advanceTimersByTime(FAST_CONFIG.cooldownMs + 10);
      expect(breaker.canAttempt()).toBe(true); // -> HALF_OPEN

      breaker.recordFailure('probe also failed');
      expect(breaker.getState()).toBe('OPEN');

      // Cooldown clock was reset by the failed probe - not enough time has
      // passed since THIS failure for another attempt yet.
      expect(breaker.canAttempt()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reset() forces a clean CLOSED state regardless of prior history (test-only escape hatch)', () => {
    const breaker = new CircuitBreaker('test', FAST_CONFIG);
    breaker.recordFailure('boom');
    breaker.recordFailure('boom');
    breaker.recordFailure('boom');
    expect(breaker.getState()).toBe('OPEN');

    breaker.reset();

    expect(breaker.getState()).toBe('CLOSED');
    expect(breaker.canAttempt()).toBe(true);
  });
});
