import {cleanup, fireEvent, render, screen} from '@testing-library/react';
import {afterEach, expect, it, vi} from 'vitest';
import {EarningsResults} from '../components/EarningsTab';
import type {EarningsRecord} from '../api/earnings';

const records: EarningsRecord[] = Array.from({length: 2000}, (_, i) => ({
  symbol: `COMPANY${i}`, filing_day: '2026-10-23', isUpcoming: false,
}));
afterEach(cleanup);

it('bounds earnings rows, reaches the last result, opens it, and keeps the window on rerender', () => {
  const onOpen = vi.fn();
  const {container, rerender} = render(<EarningsResults records={records} onOpen={onOpen} />);
  expect(container.querySelectorAll('.ep-row')).toHaveLength(22);
  const viewport = screen.getByLabelText('Earnings results, scroll for more companies');
  fireEvent.scroll(viewport, {target: {scrollTop: 120000}});
  expect(container.querySelectorAll('.ep-row')).toHaveLength(22);
  fireEvent.click(screen.getByRole('button', {name: /^COMPANY1999\b/}));
  expect(onOpen).toHaveBeenCalledWith(records[1999]);
  rerender(<EarningsResults records={[...records]} onOpen={onOpen} />);
  expect(screen.getByRole('button', {name: /^COMPANY1999\b/})).toBeInTheDocument();
});

it('renders small filtered lists in full and resets when the result scope changes', () => {
  const {rerender} = render(<EarningsResults key="all" records={records} onOpen={vi.fn()} />);
  fireEvent.scroll(screen.getByLabelText('Earnings results, scroll for more companies'), {target: {scrollTop: 120000}});
  rerender(<EarningsResults key="filtered" records={records.slice(0, 3)} onOpen={vi.fn()} />);
  expect(screen.getAllByRole('button')).toHaveLength(3);
  expect(screen.getByRole('button', {name: /^COMPANY0\b/})).toBeInTheDocument();
});
