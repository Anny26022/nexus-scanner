import {cleanup, fireEvent, render, screen} from '@testing-library/react';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {EarningsResults} from '../components/EarningsTab';
import type {EarningsRecord} from '../api/earnings';

const records: EarningsRecord[] = Array.from({length: 2000}, (_, i) => ({
  symbol: `COMPANY${i}`, filing_day: '2026-10-23', isUpcoming: false,
}));
beforeEach(() => vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('bounds earnings rows, reaches the last result, opens it, and keeps the window on rerender', () => {
  const onOpen = vi.fn();
  const {container, rerender} = render(<div className="ep"><EarningsResults records={records} onOpen={onOpen} /></div>);
  expect(container.querySelectorAll('.ep-row')).toHaveLength(22);
  const viewport = container.querySelector('.ep')!;
  vi.spyOn(container.querySelector('.ep-list')!, 'getBoundingClientRect').mockReturnValue({top: -120000} as DOMRect);
  fireEvent.scroll(viewport, {target: {scrollTop: 120000}});
  expect(container.querySelectorAll('.ep-row')).toHaveLength(22);
  fireEvent.click(screen.getByRole('button', {name: /^COMPANY1999\b/}));
  expect(onOpen).toHaveBeenCalledWith(records[1999]);
  rerender(<div className="ep"><EarningsResults records={[...records]} onOpen={onOpen} /></div>);
  expect(screen.getByRole('button', {name: /^COMPANY1999\b/})).toBeInTheDocument();
});

it('renders small filtered lists in full and resets when the result scope changes', () => {
  const {container, rerender} = render(<div className="ep"><EarningsResults key="all" records={records} onOpen={vi.fn()} /></div>);
  vi.spyOn(container.querySelector('.ep-list')!, 'getBoundingClientRect').mockReturnValue({top: -120000} as DOMRect);
  fireEvent.scroll(container.querySelector('.ep')!, {target: {scrollTop: 120000}});
  rerender(<div className="ep"><EarningsResults key="filtered" records={records.slice(0, 3)} onOpen={vi.fn()} /></div>);
  expect(screen.getAllByRole('button')).toHaveLength(3);
  expect(screen.getByRole('button', {name: /^COMPANY0\b/})).toBeInTheDocument();
});
