import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { readStored, storageHealth, writeStored } from '../storage/store';
import { useStoredState } from '../storage/useStoredState';
import { DrawingBook } from '../chart/drawings';
import { drawingStyles, readChartStorage } from '../chart/storage';

afterEach(() => { cleanup(); vi.restoreAllMocks(); localStorage.clear(); });

function Counter({label}: {label: string}) {
  const [count, setCount] = useStoredState('test.count.v1', 0);
  return <button type="button" onClick={() => setCount(value => value + 1)}>{label} {count}</button>;
}

it('keeps every reader of a key on the same value', () => {
  render(<><Counter label="A" /><Counter label="B" /></>);
  fireEvent.click(screen.getByRole('button', {name: 'A 0'}));
  expect(screen.getByRole('button', {name: 'B 1'})).toBeInTheDocument();
  expect(readStored('test.count.v1', 0)).toBe(1);
});

it('follows writes made in another tab', () => {
  render(<Counter label="A" />);
  act(() => {
    localStorage.setItem('test.count.v1', '7');
    window.dispatchEvent(new StorageEvent('storage', {key: 'test.count.v1', storageArea: localStorage}));
  });
  expect(screen.getByRole('button', {name: 'A 7'})).toBeInTheDocument();
});

it('keeps working in memory and warns once when the browser refuses to save', () => {
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Full', 'QuotaExceededError'); });
  render(<Counter label="A" />);
  fireEvent.click(screen.getByRole('button', {name: 'A 0'}));
  expect(screen.getByRole('button', {name: 'A 1'})).toBeInTheDocument();
  expect(storageHealth.getSnapshot()).toMatch(/not being saved/);
  vi.restoreAllMocks();
  expect(writeStored('test.count.v1', 2)).toBe(true);
  expect(storageHealth.getSnapshot()).toBe('');
});

it('starts each new drawing with the style last chosen for its tool', () => {
  const book = new DrawingBook([], undefined, drawingStyles);
  const at = (day: number, price: number) => ({time: Date.UTC(2026, 0, day), price});
  book.add('trendline', at(1, 10), at(5, 20));
  const first = book.getSnapshot().drawings[0];
  expect(first).toMatchObject({color: 'accent', width: 1.5});
  book.update(first.id, {color: '#f23645', width: 3, dash: 'dashed'});
  expect((readChartStorage('drawing-styles.v1') as Record<string, unknown>).trendline).toEqual({color: '#f23645', width: 3, dash: 'dashed'});
  book.add('trendline', at(2, 11), at(6, 21));
  expect(book.getSnapshot().drawings[1]).toMatchObject({color: '#f23645', width: 3, dash: 'dashed'});
  // Other tools keep their own memory.
  book.add('horizontal', at(3, 15));
  expect(book.getSnapshot().drawings[2]).toMatchObject({color: 'accent', width: 1.5});
});
