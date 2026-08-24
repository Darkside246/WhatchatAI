import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFatalHandler, installCrashSafetyHandlers } from '../src/process/crashSafety.js';

describe('createFatalHandler', () => {
  it('runs shutdown once and exits(1) on a fatal error', async () => {
    const shutdown = vi.fn().mockResolvedValue(undefined);
    const exit = vi.fn();
    const handleFatal = createFatalHandler('Test', shutdown, { exit });

    handleFatal('uncaughtException', new Error('boom'));

    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  it('only runs shutdown once even if a second fatal error arrives mid-shutdown', async () => {
    let resolveShutdown!: () => void;
    const shutdown = vi.fn().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveShutdown = resolve;
        }),
    );
    const exit = vi.fn();
    const handleFatal = createFatalHandler('Test', shutdown, { exit });

    handleFatal('uncaughtException', new Error('first'));
    handleFatal('unhandledRejection', new Error('second - arrives while still shutting down'));

    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();

    resolveShutdown();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
  });

  it('still exits(1) if shutdown itself rejects, and logs the secondary error rather than throwing', async () => {
    const shutdown = vi.fn().mockRejectedValue(new Error('shutdown failed too'));
    const exit = vi.fn();
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const handleFatal = createFatalHandler('Test', shutdown, { exit });

    handleFatal('uncaughtException', new Error('boom'));

    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Error during crash shutdown'), expect.any(Error));
    consoleErrorSpy.mockRestore();
  });

  it('force-exits if shutdown never resolves, via the injectable delay', async () => {
    const shutdown = vi.fn().mockImplementation(() => new Promise<void>(() => {})); // never resolves
    const exit = vi.fn();
    const handleFatal = createFatalHandler('Test', shutdown, { exit, forceExitDelayMs: 20 });

    handleFatal('uncaughtException', new Error('boom'));

    expect(exit).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1), { timeout: 1_000 });
  });
});

describe('installCrashSafetyHandlers', () => {
  afterEach(() => {
    process.removeAllListeners('uncaughtException');
    process.removeAllListeners('unhandledRejection');
  });

  it('registers exactly one uncaughtException and one unhandledRejection listener on the real process', () => {
    const before = {
      uncaught: process.listenerCount('uncaughtException'),
      unhandled: process.listenerCount('unhandledRejection'),
    };

    installCrashSafetyHandlers('Test', vi.fn().mockResolvedValue(undefined));

    expect(process.listenerCount('uncaughtException')).toBe(before.uncaught + 1);
    expect(process.listenerCount('unhandledRejection')).toBe(before.unhandled + 1);
  });
});
