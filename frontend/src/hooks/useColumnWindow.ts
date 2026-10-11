import { useState, type UIEvent } from 'react';

/** Keep wide tables bounded in both directions; gaps retain exact scroll width. */
export function useColumnWindow<T>(columns: T[], widthOf: (column: T) => number, enabled: boolean) {
  const [viewport, setViewport] = useState({left: 0, width: typeof window === 'undefined' ? 1920 : window.innerWidth});
  let offset = 0;
  const bounds = columns.map(column => {
    const left = offset;
    offset += widthOf(column);
    return {left, right: offset};
  });
  const first = enabled ? Math.max(0, bounds.findIndex(bound => bound.right > viewport.left) - 2) : 0;
  const lastVisible = bounds.findIndex(bound => bound.left >= viewport.left + viewport.width);
  const end = enabled && lastVisible !== -1 ? Math.min(columns.length, lastVisible + 2) : columns.length;
  return {
    columns: columns.slice(first, end), first,
    left: first > 0 ? bounds[first].left : 0,
    right: end < columns.length ? offset - bounds[end].left : 0,
    onScroll: (event: UIEvent<HTMLDivElement>) => {
      if (!enabled) return;
      const {scrollLeft: left, clientWidth: width} = event.currentTarget;
      setViewport(current => current.left === left && current.width === width ? current : {left, width});
    },
  };
}
