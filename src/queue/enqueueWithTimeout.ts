/**
 * BullMQ's own required setting for a worker connection is
 * `maxRetriesPerRequest: null` (see connection.ts) - it means ioredis
 * retries a command forever rather than rejecting, which is correct for a
 * background worker with no deadline. It is the wrong behavior for an
 * HTTP request awaiting `queue.add()` directly: verified empirically in
 * this phase (Phase 19 failure-injection testing) by adding a real job to
 * a real BullMQ queue with Redis stopped - the promise neither resolved
 * nor rejected, it simply never returned, for as long as Redis stayed
 * down. Any route awaiting an enqueue call (a composer send, a campaign
 * send, a funnel WAIT step) would hang the request indefinitely instead
 * of failing honestly.
 *
 * This does not change delivery correctness, only response latency: every
 * call site that uses this wraps an enqueue that follows a durable
 * Postgres row already being created (e.g. the outbound_messages row in
 * whatsappOutboundMessageService.send()), so if Redis is merely slow to
 * reconnect, the underlying add() keeps retrying in the background and
 * still succeeds once it recovers; if Redis stays down long enough, the
 * existing stale-row reconciliation sweeps (sweepStaleOutboundMessages,
 * etc.) already exist to fail it honestly and notify the business. This
 * helper's only job is to stop an HTTP request from blocking on an
 * enqueue call that may never return promptly.
 */
export async function enqueueWithTimeout<T>(promise: Promise<T>, label: string, timeoutMs = 5000): Promise<void> {
  let timedOut = false;
  const timeout = new Promise<void>((resolve) => {
    setTimeout(() => {
      timedOut = true;
      resolve();
    }, timeoutMs);
  });

  await Promise.race([promise.then(() => undefined), timeout]);

  if (timedOut) {
    console.warn(
      `[enqueueWithTimeout] "${label}" did not confirm within ${timeoutMs}ms (Redis may be unreachable) - continuing without blocking the caller; the underlying job keeps retrying in the background.`,
    );
    // Never left unhandled: if the deferred add() eventually rejects for a
    // real reason (not just slow reconnect), it is logged, not silently lost.
    promise.catch((error) => {
      console.error(`[enqueueWithTimeout] Deferred "${label}" ultimately failed:`, error);
    });
  }
}
