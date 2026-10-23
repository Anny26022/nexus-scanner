import { afterEach, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ChartLegend } from '../components/ChartLegend';
import { formatDuration, marketOpen, secondsToNextBoundary } from '../chart/marketHours';

afterEach(cleanup);
const bar = { date: '2026-10-02', open: 10, high: 12, low: 9, close: 11, volume: 1000 };
const status = { marketStatus: true, ohlc: true, change: true, volume: true };

it('shows and hides each status-line element', () => {
  const { rerender } = render(<ChartLegend symbol="TCS" bar={bar} status={status} />);
  // The toolbar already names the symbol, so the status line never repeats it.
  expect(screen.queryByText('TCS')).not.toBeInTheDocument();
  expect(screen.getByLabelText(/Market (open|closed)/)).toBeInTheDocument();
  expect(screen.getByText('O')).toBeInTheDocument();
  expect(screen.getByText('Vol')).toBeInTheDocument();
  rerender(<ChartLegend symbol="TCS" bar={bar} status={{ ...status, ohlc: false, volume: false, marketStatus: false }} />);
  expect(screen.queryByText('O')).not.toBeInTheDocument();
  expect(screen.queryByText('Vol')).not.toBeInTheDocument();
  expect(screen.queryByLabelText(/Market (open|closed)/)).not.toBeInTheDocument();
});

it('knows NSE hours in IST', () => {
  expect(marketOpen(new Date('2026-10-22T05:00:00Z'))).toBe(true); // Thu 10:30 IST
  expect(marketOpen(new Date('2026-10-22T10:30:00Z'))).toBe(false); // Thu 16:00 IST
  expect(marketOpen(new Date('2026-10-24T05:00:00Z'))).toBe(false); // Saturday
  expect(secondsToNextBoundary(new Date('2026-10-22T09:00:00Z'))).toEqual({ open: true, seconds: 60 * 60 }); // 14:30 → 15:30
  expect(secondsToNextBoundary(new Date('2026-10-23T10:30:00Z')).seconds).toBe((2 * 24 + 17) * 3600 + 15 * 60); // Fri 16:00 → Mon 09:15
  expect(formatDuration(3725)).toBe('1h 02m');
});
