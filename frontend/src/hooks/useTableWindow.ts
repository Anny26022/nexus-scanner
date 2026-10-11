import { useState, type UIEvent } from 'react';

const ROW_HEIGHT = 50;
// The table viewport is capped at 780px: 16 visible rows plus six overscan rows.
const WINDOW_ROWS = 22;

/** Bound wide-table DOM work while retaining the full page's scroll height. */
export function useTableWindow<T>(rows: T[], key: unknown, columnCount: number) {
  const [window, setWindow] = useState({key, first: 0});
  const enabled = rows.length > WINDOW_ROWS && columnCount > 20;
  const first = enabled && window.key === key ? Math.min(window.first, Math.max(0, rows.length - WINDOW_ROWS)) : 0;
  const end = enabled ? Math.min(rows.length, first + WINDOW_ROWS) : rows.length;
  return {
    rows: rows.slice(first, end), first,
    top: first * ROW_HEIGHT,
    bottom: (rows.length - end) * ROW_HEIGHT,
    enabled,
    onScroll: (event: UIEvent<HTMLDivElement>) => {
      if (!enabled) return;
      const next = Math.max(0, Math.floor((event.currentTarget.scrollTop - 42) / ROW_HEIGHT) - 5);
      setWindow(current => current.key === key && current.first === next ? current : {key, first: next});
    },
  };
}
