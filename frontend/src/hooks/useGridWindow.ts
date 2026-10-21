import { useState, useSyncExternalStore, type UIEvent } from 'react';

const mediaQuery = '(max-width: 900px)';
const subscribeMedia = (notify: () => void) => {
  const media = typeof window !== 'undefined' ? window.matchMedia?.(mediaQuery) : null;
  media?.addEventListener('change', notify);
  return () => media?.removeEventListener('change', notify);
};

// Desktop: 2 columns, ~440px row height; Mobile: 1 column, ~380px row height
const DESKTOP_ROW_HEIGHT = 440;
const MOBILE_ROW_HEIGHT = 380;
const OVERSCAN_ROWS = 2;
const VISIBLE_ROWS = 4;
const WINDOW_ROWS = VISIBLE_ROWS + 2 * OVERSCAN_ROWS; // 8 rows total (up to 16 cards on desktop)

/** Bound quick chart gallery DOM work while retaining the full grid's scroll height. */
export function useGridWindow<T>(items: T[], key: unknown) {
  const isSingleColumn = useSyncExternalStore(
    subscribeMedia,
    () => typeof window !== 'undefined' && (window.matchMedia?.(mediaQuery).matches ?? false),
    () => false
  );
  const columns = isSingleColumn ? 1 : 2;
  const rowHeight = isSingleColumn ? MOBILE_ROW_HEIGHT : DESKTOP_ROW_HEIGHT;
  const totalRows = Math.ceil(items.length / columns);
  const enabled = items.length > WINDOW_ROWS * columns;

  const [windowState, setWindowState] = useState({ key, firstRow: 0 });

  const firstRow = enabled && windowState.key === key
    ? Math.min(windowState.firstRow, Math.max(0, totalRows - WINDOW_ROWS))
    : 0;
  const endRow = enabled ? Math.min(totalRows, firstRow + WINDOW_ROWS) : totalRows;

  const firstIndex = enabled ? firstRow * columns : 0;
  const endIndex = enabled ? Math.min(items.length, endRow * columns) : items.length;

  return {
    items: items.slice(firstIndex, endIndex),
    firstIndex,
    top: enabled ? firstRow * rowHeight : 0,
    bottom: enabled ? (totalRows - endRow) * rowHeight : 0,
    enabled,
    onScroll: (event: UIEvent<HTMLDivElement>) => {
      if (!enabled) return;
      const nextRow = Math.max(0, Math.floor(event.currentTarget.scrollTop / rowHeight) - OVERSCAN_ROWS);
      setWindowState(current => current.key === key && current.firstRow === nextRow ? current : { key, firstRow: nextRow });
    },
  };
}
