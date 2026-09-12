import { useEffect, useRef } from 'react';

/**
 * Polls on an interval, but only while the page is actually being looked at.
 *
 * WHAT THIS IS FOR. A signed-in workspace runs seven independent pollers -
 * connection status every 2.5s, urgent handovers every 5s, the open chat
 * every 6s, the chat list, statuses and calls every 8s, the clock every 30s
 * - which is roughly eighty HTTP requests a minute, each one a request, a
 * JSON parse, a state update and a re-render of a large tree. None of it
 * stopped when the tab was in the background. An operator with the app open
 * in a spare tab, or a phone with it backgrounded, kept that up all day
 * against both their battery and the server.
 *
 * Every one of these pollers is a FALLBACK. Real updates arrive over the
 * realtime channel (useWhatsAppSync); the intervals exist to catch what the
 * channel misses. So skipping them while nobody is watching cannot lose
 * anything - and the moment the page is looked at again, this fetches
 * immediately rather than waiting out the remaining interval, so what
 * appears on screen is current.
 *
 * DELIBERATELY NOT A THROTTLE. Slowing the interval down in the background
 * would still wake the device, still spend the battery, and still cost the
 * request - just less often. The honest answer to "is anyone reading this?"
 * is yes or no, and the polling follows it.
 */
export function useVisiblePolling(callback: () => void, intervalMs: number, enabled = true): void {
  // Held in a ref so a caller can pass an inline closure - the usual React
  // shape - without the interval being torn down and rebuilt on every
  // render, which would reset the clock and never actually fire.
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  useEffect(() => {
    if (!enabled) return;

    let timer: ReturnType<typeof setInterval> | undefined;

    const start = () => {
      if (timer !== undefined) return;
      timer = setInterval(() => callbackRef.current(), intervalMs);
    };
    const stop = () => {
      if (timer === undefined) return;
      clearInterval(timer);
      timer = undefined;
    };

    const onVisibilityChange = () => {
      if (document.hidden) {
        stop();
        return;
      }
      // Catch up first, then resume. Waiting out the rest of the interval
      // would show a stale screen for up to 8 seconds at the exact moment
      // someone came back to look at it.
      callbackRef.current();
      start();
    };

    if (!document.hidden) start();
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [intervalMs, enabled]);
}
