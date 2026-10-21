import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useGridWindow } from '../hooks/useGridWindow';

describe('useGridWindow', () => {
  it('does not window small item sets', () => {
    const items = Array.from({ length: 10 }, (_, i) => ({ id: i }));
    const { result } = renderHook(() => useGridWindow(items, 'key-1'));

    expect(result.current.enabled).toBe(false);
    expect(result.current.items).toHaveLength(10);
    expect(result.current.firstIndex).toBe(0);
    expect(result.current.top).toBe(0);
    expect(result.current.bottom).toBe(0);
  });

  it('windows large item sets with top and bottom spacers', () => {
    const items = Array.from({ length: 100 }, (_, i) => ({ id: i }));
    const { result } = renderHook(() => useGridWindow(items, 'key-1'));

    expect(result.current.enabled).toBe(true);
    // Desktop: 2 columns -> WINDOW_ROWS = 8 rows = 16 items
    expect(result.current.items).toHaveLength(16);
    expect(result.current.firstIndex).toBe(0);
    expect(result.current.top).toBe(0);
    // Total rows = 50. Visible + overscan = 8 rows. Remaining = 42 rows. 42 * 418 = 17556
    expect(result.current.bottom).toBe(42 * 418);
  });

  it('updates the window on scroll', () => {
    const items = Array.from({ length: 100 }, (_, i) => ({ id: i }));
    const { result } = renderHook(() => useGridWindow(items, 'key-1'));

    // Scroll down to row 10 (10 * 418 = 4180px)
    act(() => {
      result.current.onScroll({
        currentTarget: { scrollTop: 4180 },
      } as any);
    });

    // nextRow = Math.max(0, 10 - 2) = 8.
    // firstRow = 8. endRow = 8 + 8 = 16.
    // firstIndex = 8 * 2 = 16. endIndex = 16 * 2 = 32.
    expect(result.current.firstIndex).toBe(16);
    expect(result.current.items).toHaveLength(16);
    expect(result.current.items[0]).toEqual({ id: 16 });
    expect(result.current.top).toBe(8 * 418);
    expect(result.current.bottom).toBe((50 - 16) * 418);
  });

  it('resets window to top when key changes', () => {
    const items = Array.from({ length: 100 }, (_, i) => ({ id: i }));
    let key = 'key-1';
    const { result, rerender } = renderHook(() => useGridWindow(items, key));

    act(() => {
      result.current.onScroll({
        currentTarget: { scrollTop: 4180 },
      } as any);
    });
    expect(result.current.firstIndex).toBe(16);

    // Change key (e.g. new query or sort)
    key = 'key-2';
    rerender();

    expect(result.current.firstIndex).toBe(0);
    expect(result.current.top).toBe(0);
  });
});
