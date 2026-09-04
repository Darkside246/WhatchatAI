import type { Job, Worker } from 'bullmq';

/**
 * AURA engineering directive, "Test worker isolation" / "Remove race
 * conditions" (2026-09-04): a real, reusable, leak-free primitive for
 * "wait for a specific BullMQ job to reach a terminal state" -
 * `aiReplyWorkerIntegration.test.ts`, `incomingMessagesQueue.test.ts`, and
 * `operatorSelfChatRouting.test.ts` (5 separate inline copies in the last
 * one alone) each previously hand-rolled this same `new Promise(...)`
 * shape, and every copy had the same real bug: on the timeout path, the
 * 'completed'/'failed' listeners were never removed via `.off()` - only
 * the success path cleaned up - so a timed-out wait left a permanently
 * attached listener on the shared worker for the rest of that file's test
 * run, checked (harmlessly, but wastefully, and a real event-listener
 * leak) against every later job. Fixed here once, centrally, with a
 * single `settled` guard and an always-run `cleanup()` reached from every
 * exit path (resolve, reject-via-event, reject-via-timeout).
 *
 * `matchFailed` is optional so a caller that only cares about 'completed'
 * (e.g. waiting for a real ai-debounce round, which has no meaningful
 * "failed" outcome to react to) never registers a 'failed' listener it
 * would also have to clean up.
 */
export function waitForWorkerEvent<T>(
  worker: Worker<T>,
  matchCompleted: (job: Job<T>) => boolean,
  timeoutMs: number,
  timeoutMessage: string,
  matchFailed?: (job: Job<T> | undefined) => boolean,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(timeoutMessage));
    }, timeoutMs);

    function onCompleted(job: Job<T>) {
      if (settled || !matchCompleted(job)) return;
      settled = true;
      cleanup();
      resolve();
    }
    function onFailed(job: Job<T> | undefined, error: Error) {
      if (settled || !matchFailed?.(job)) return;
      settled = true;
      cleanup();
      reject(error);
    }
    function cleanup() {
      clearTimeout(timeout);
      worker.off('completed', onCompleted);
      if (matchFailed) worker.off('failed', onFailed);
    }

    worker.on('completed', onCompleted);
    if (matchFailed) worker.on('failed', onFailed);
  });
}

/**
 * The extremely common specific case across these files: wait for one
 * real incoming-message job (matched by its real WhatsApp messageId) to
 * reach a terminal state on `incomingMessagesWorker`.
 */
export function waitForIncomingMessageJob<T extends { message: { messageId: string } }>(
  worker: Worker<T>,
  messageId: string,
  timeoutMs = 10_000,
): Promise<void> {
  return waitForWorkerEvent<T>(
    worker,
    (job) => job.data.message.messageId === messageId,
    timeoutMs,
    'Timed out waiting for worker to process job',
    (job) => job?.data.message.messageId === messageId,
  );
}
