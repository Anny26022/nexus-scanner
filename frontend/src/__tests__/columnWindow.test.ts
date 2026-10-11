import { act, renderHook } from '@testing-library/react';
import { expect, it } from 'vitest';
import type { UIEvent } from 'react';
import { useColumnWindow } from '../hooks/useColumnWindow';

it('preserves full width and reaches final columns when scrolling horizontally', () => {
  const columns = Array.from({length: 115}, (_, index) => index);
  const {result} = renderHook(() => useColumnWindow(columns, () => 150, true));
  expect(result.current.columns.length).toBeLessThan(20);
  expect(result.current.left + result.current.columns.length * 150 + result.current.right).toBe(17250);
  act(() => result.current.onScroll({currentTarget: {scrollLeft: 16000, clientWidth: 1250}} as UIEvent<HTMLDivElement>));
  expect(result.current.columns.at(-1)).toBe(114);
  expect(result.current.right).toBe(0);
  expect(result.current.left + result.current.columns.length * 150).toBe(17250);
});

it('leaves ordinary columns intact and safely handles selection reset', () => {
  const {result, rerender} = renderHook(({count, enabled}) => useColumnWindow(Array.from({length: count}, (_, index) => index), () => 150, enabled),
    {initialProps: {count: 115, enabled: true}});
  act(() => result.current.onScroll({currentTarget: {scrollLeft: 16000, clientWidth: 1250}} as UIEvent<HTMLDivElement>));
  rerender({count: 8, enabled: false});
  expect(result.current.columns).toHaveLength(8);
  expect(result.current.left + result.current.right).toBe(0);
});
