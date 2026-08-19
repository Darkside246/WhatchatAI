/** Dispatched to trigger the screen lock from outside ScreenLock.tsx itself (e.g. a "Lock now" button in Settings). */
export const LOCK_NOW_EVENT = 'whatchatai-lock-now';

export function triggerLockNow(): void {
  window.dispatchEvent(new CustomEvent(LOCK_NOW_EVENT));
}
