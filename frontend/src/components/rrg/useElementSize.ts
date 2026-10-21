import { useCallback, useRef, useState, useSyncExternalStore } from "react";

export interface ElementSize {
  width: number;
  height: number;
}

const EMPTY: ElementSize = { width: 0, height: 0 };

/**
 * Tracks an element's rendered size without useEffect: a ResizeObserver
 * publishes into a stable snapshot that useSyncExternalStore reads.
 */
export function useElementSize<T extends HTMLElement>() {
  const [node, setNode] = useState<T | null>(null);
  const sizeRef = useRef<ElementSize>(EMPTY);

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (!node) return () => {};
      const observer = new ResizeObserver((entries) => {
        const box = entries[0]?.contentRect;
        if (!box) return;
        const next = {
          width: Math.round(box.width),
          height: Math.round(box.height),
        };
        const current = sizeRef.current;
        if (current.width === next.width && current.height === next.height) return;
        sizeRef.current = next;
        onStoreChange();
      });
      observer.observe(node);
      return () => observer.disconnect();
    },
    [node],
  );

  const getSnapshot = useCallback(() => sizeRef.current, []);
  const getServerSnapshot = useCallback(() => EMPTY, []);

  const size = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const ref = useCallback((element: T | null) => setNode(element), []);

  return [ref, size] as const;
}
