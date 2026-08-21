import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { enqueueWithTimeout } from '../src/queue/enqueueWithTimeout.js';

describe('enqueueWithTimeout (real failure-injection finding, Phase 19)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves promptly when the underlying enqueue resolves before the timeout', async () => {
    const promise = enqueueWithTimeout(Promise.resolve('job-1'), 'test job', 5000);
    await vi.advanceTimersByTimeAsync(0);
    await expect(promise).resolves.toBeUndefined();
  });

  it('does not hang forever when the underlying enqueue never resolves (e.g. Redis is unreachable) - returns once the timeout elapses', async () => {
    const neverResolves = new Promise<void>(() => {});
    // A rejection this promise-that-never-resolves eventually produces is
    // exactly the shape a real BullMQ .add() call takes against a dead
    // Redis: it neither resolves nor rejects promptly (verified empirically
    // in this phase against a real, stopped Redis instance) - the point of
    // this wrapper is that the CALLER must never be left hanging on it.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const promise = enqueueWithTimeout(neverResolves, 'stalled job', 5000);
    await vi.advanceTimersByTimeAsync(5000);
    await expect(promise).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('stalled job'));

    warnSpy.mockRestore();
  });

  it('a deferred rejection after the timeout is logged, never an unhandled rejection', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let rejectDeferred!: (error: Error) => void;
    const deferred = new Promise<void>((_resolve, reject) => {
      rejectDeferred = reject;
    });

    const promise = enqueueWithTimeout(deferred, 'eventually-fails job', 5000);
    await vi.advanceTimersByTimeAsync(5000);
    await promise;

    rejectDeferred(new Error('connection refused'));
    await vi.advanceTimersByTimeAsync(0);
    // Flush the microtask queue so the deferred .catch() handler runs.
    await Promise.resolve();

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('eventually-fails job'), expect.any(Error));

    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });
});
