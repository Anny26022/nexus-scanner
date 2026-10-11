import { act, renderHook } from '@testing-library/react';
import { expect, it } from 'vitest';
import type { UIEvent } from 'react';
import { useTableWindow } from '../hooks/useTableWindow';

it('bounds wide tables, reaches the last row, and resets on a different page', () => {
  const rows = Array.from({length: 100}, (_, index) => index);
  const {result, rerender} = renderHook(({key}) => useTableWindow(rows, key, 115), {initialProps: {key: 1}});
  expect(result.current.rows).toHaveLength(22);
  expect(result.current.bottom).toBe(3900);
  act(() => result.current.onScroll({currentTarget: {scrollTop: 5000}} as UIEvent<HTMLDivElement>));
  expect(result.current.rows.at(-1)).toBe(99);
  expect(result.current.top).toBe(3900);
  expect(result.current.bottom).toBe(0);
  rerender({key: 2});
  expect(result.current.first).toBe(0);
});

it('leaves ordinary narrow tables fully rendered', () => {
  const rows = Array.from({length: 100}, (_, index) => index);
  const {result} = renderHook(() => useTableWindow(rows, 1, 8));
  expect(result.current.enabled).toBe(false);
  expect(result.current.rows).toHaveLength(100);
  expect(result.current.top + result.current.bottom).toBe(0);
});

it.each([0, 15, 22])('fully renders a short wide page with %i rows', count => {
  const rows = Array.from({length: count}, (_, index) => index);
  const {result} = renderHook(() => useTableWindow(rows, 1, 115));
  expect(result.current.enabled).toBe(false);
  expect(result.current.rows).toEqual(rows);
  expect(result.current.top + result.current.bottom).toBe(0);
});
