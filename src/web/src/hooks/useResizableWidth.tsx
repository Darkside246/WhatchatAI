import { useCallback, useRef, useState } from 'react';

/**
 * A draggable-width panel, persisted per-viewer in localStorage (a
 * layout preference, not data - matches this app's own established
 * convention for this kind of per-user UI state, e.g. AiAgentSettingsPanels'
 * card ordering). `edge` says which side of the panel the drag handle sits
 * on: 'right' (the handle is this panel's own right border - dragging it
 * further right grows the panel) or 'left' (the handle is this panel's own
 * left border - dragging it further left grows the panel, since the panel
 * occupies the space from the handle to its OTHER, fixed edge).
 */
export function useResizableWidth(storageKey: string, defaultWidth: number, min: number, max: number, edge: 'left' | 'right' = 'right') {
  const [width, setWidth] = useState<number>(() => {
    try {
      const stored = window.localStorage.getItem(storageKey);
      const parsed = stored ? Number(stored) : NaN;
      return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : defaultWidth;
    } catch {
      return defaultWidth;
    }
  });
  const widthRef = useRef(width);
  widthRef.current = width;

  const onHandlePointerDown = useCallback((event: React.PointerEvent) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = widthRef.current;

    function onMove(moveEvent: PointerEvent) {
      const rawDelta = moveEvent.clientX - startX;
      const delta = edge === 'right' ? rawDelta : -rawDelta;
      setWidth(Math.min(max, Math.max(min, startWidth + delta)));
    }
    function onUp() {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      try {
        window.localStorage.setItem(storageKey, String(widthRef.current));
      } catch {
        // Best-effort only - a private window or blocked storage just means this resize isn't remembered next visit.
      }
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [storageKey, min, max, edge]);

  return { width, onHandlePointerDown };
}

/** A thin, always-visible drag handle for use with useResizableWidth - a 1px visible divider with a wider invisible hit area so it's easy to grab without feeling fat. */
export function ResizeHandle({ onPointerDown, className = '' }: { onPointerDown: (event: React.PointerEvent) => void; className?: string }) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      onPointerDown={onPointerDown}
      className={`group relative w-1 shrink-0 cursor-col-resize touch-none ${className}`}
    >
      <div className="absolute inset-y-0 -left-1.5 -right-1.5" />
      <div className="h-full w-full bg-border-subtle transition-colors group-hover:bg-accent" />
    </div>
  );
}
