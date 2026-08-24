/**
 * Global safety net for uncaught exceptions and unhandled promise
 * rejections in a long-running entrypoint (the API/WhatsApp-connection
 * process, the incoming-messages worker process).
 *
 * Written after a real incident: Baileys' own media-download pipeline
 * (`downloadEncryptedContent` in @whiskeysockets/baileys) does
 * `fetched.pipe(output, { end: true })` without first attaching an
 * `error` listener to `fetched` - a well-known Node.js stream footgun.
 * `.pipe()` never forwards the source stream's own `error` events to the
 * destination, and Node's default behavior for an `error` event with no
 * listener is to throw synchronously, wherever it's emitted - in this
 * case deep inside undici's socket-close handling, entirely outside any
 * caller's own try/catch (the promise this codebase awaits had already
 * resolved). The result: a mid-transfer network drop (a laptop coming
 * back from standby is a real, ordinary way to trigger one) crashed the
 * whole worker process with no chance for the existing retry/circuit-
 * breaker machinery in incomingMessagesWorker.ts to ever see it.
 *
 * This cannot fix that bug - it lives inside a third-party dependency,
 * and the stream it fails to guard is never exposed to this codebase's
 * own call sites to attach a listener to. What this *can* do is make the
 * resulting crash loud and recoverable instead of silent: log full
 * detail (today, nothing distinguishes this from any other exit beyond
 * a raw stack dump), close BullMQ workers cleanly so in-flight jobs
 * aren't left in a state the crash-recovery sweeps can't reconcile, and
 * exit promptly so a real process supervisor (docker-compose's
 * `restart: unless-stopped` in production) can bring the process back
 * up. Any other dependency with the same footgun anywhere else in this
 * app is covered by the same net, not just this one incident.
 */

export interface FatalHandlerOptions {
  /** Injectable for tests - defaults to the real process.exit. */
  exit?: (code: number) => void;
  /** Injectable for tests, so a hung-shutdown test doesn't need to wait 5 real seconds. */
  forceExitDelayMs?: number;
}

/**
 * The actual crash-handling logic, factored out from the real
 * process.on(...) wiring below so it can be unit tested directly against
 * an injected shutdown function and exit callback - never touching the
 * real global `process` object's event listeners in a test.
 */
export function createFatalHandler(
  processLabel: string,
  shutdown: () => Promise<void>,
  options: FatalHandlerOptions = {},
): (kind: string, error: unknown) => void {
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const forceExitDelayMs = options.forceExitDelayMs ?? 5_000;
  let handling = false;

  return function handleFatal(kind: string, error: unknown): void {
    // A second fatal error arriving while already shutting down from the
    // first one - already on the way out, let that shutdown finish rather
    // than racing a second one against it.
    if (handling) return;
    handling = true;

    console.error(`[${processLabel}] FATAL (${kind}) - shutting down:`, error);

    // Safety valve: if shutdown() itself never resolves (e.g. a hung DB
    // call), never let the process linger half-torn-down indefinitely.
    // unref() so this timer alone can't keep the event loop alive once a
    // normal shutdown already completed and called exit itself.
    const forceExit = setTimeout(() => exit(1), forceExitDelayMs);
    forceExit.unref();

    shutdown()
      .catch((shutdownError) => {
        console.error(`[${processLabel}] Error during crash shutdown:`, shutdownError);
      })
      .finally(() => exit(1));
  };
}

export function installCrashSafetyHandlers(processLabel: string, shutdown: () => Promise<void>): void {
  const handleFatal = createFatalHandler(processLabel, shutdown);
  process.on('uncaughtException', (error) => handleFatal('uncaughtException', error));
  process.on('unhandledRejection', (reason) => handleFatal('unhandledRejection', reason));
}
