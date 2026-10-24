import { useState, type UIEvent } from 'react';

const ROW_HEIGHT = 50;
// The table viewport is capped at 780px: 16 visible rows plus six overscan rows.
const WINDOW_ROWS = 22;

/** Bound wide-table DOM work while retaining the full page's scroll height. */
export function useTableWindow<T>(rows: T[], key: unknown, columnCount: number, options: {rowHeight?: number; headerHeight?: number; narrow?: boolean} = {}) {
  const [window, setWindow] = useState({key, first: 0, rowHeight: options.rowHeight ?? ROW_HEIGHT, size: WINDOW_ROWS});
  const {rowHeight, size} = window;
  const enabled = rows.length > WINDOW_ROWS && (columnCount > 20 || options.narrow === true);
  const first = enabled && window.key === key ? Math.min(window.first, Math.max(0, rows.length - size)) : 0;
  const end = enabled ? Math.min(rows.length, first + size) : rows.length;
  const update = (scrollTop: number, height?: number, pitch = rowHeight) => {
    if (!enabled) return;
    const size = height === undefined ? WINDOW_ROWS : Math.max(WINDOW_ROWS, Math.ceil(height / pitch) + 10);
    const first = Math.max(0, Math.floor((scrollTop - (options.headerHeight ?? 42)) / pitch) - 5);
    setWindow(current => current.key === key && current.first === first && current.rowHeight === pitch && current.size === size
      ? current : {key, first, rowHeight: pitch, size});
  };
  return {
    rows: rows.slice(first, end), first,
    top: first * rowHeight,
    bottom: (rows.length - end) * rowHeight,
    enabled,
    update,
    onScroll: (event: UIEvent<HTMLDivElement>) => update(event.currentTarget.scrollTop),
  };
}
