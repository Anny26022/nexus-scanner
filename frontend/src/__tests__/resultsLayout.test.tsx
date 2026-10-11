import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ResultsTable } from '../components/ResultsTable';
import { Pagination } from '../components/Pagination';
import { pagePlaceholder } from '../utils/pagePlaceholder';
import type { ScreenerRunRequest, ScreenerRunResponse, StockRow } from '../types/screener';

afterEach(cleanup);
const request: ScreenerRunRequest = {datasetRevision: 'a'.repeat(64), universe: 'mainboard', asOfDate: '2026-10-09',
  expressionTree: {type: 'group', operator: 'all', children: []}, page: 1, pageSize: 15, sort: {field: 'rvol', direction: 'desc'}};
const row = {symbol: 'AVTNPL', name: 'Avt Natural Products', sector: 'FMCG', industry: 'Agricultural Products',
  close: 94.78, changePct: 10.92, rvol: 19.22, marketCapCrore: 1443, rsRating: 87, rsi14: 57.99, deliveryPct: null} as StockRow;
const data = {rows: [row], matchCount: 16, totalUniverseCount: 2600, page: 1, pageSize: 15, immutableRevision: request.datasetRevision} as ScreenerRunResponse;
const props = {isLoading: false, isError: false, onPageChange: vi.fn(), onSortChange: vi.fn()};

it('keeps table, column definitions and pagination mounted across loading, results, short final page, empty and error states', () => {
  const view = render(<ResultsTable {...props} isLoading />);
  const table = screen.getByRole('table');
  const pager = screen.getByRole('navigation', {name: 'Results pagination'});
  const widths = [...table.querySelectorAll('col')].map(col => col.style.width);
  for (const state of [{data}, {data: {...data, page: 2}}, {data: {...data, matchCount: 0, rows: []}}, {isError: true, error: new Error('Offline')}]) {
    view.rerender(<ResultsTable {...props} {...state} />);
    expect(screen.getByRole('table')).toBe(table);
    expect(screen.getByRole('navigation', {name: 'Results pagination'})).toBe(pager);
    expect([...table.querySelectorAll('col')].map(col => col.style.width)).toEqual(widths);
  }
});

it('disables exports and page changes while previous-page data is updating', () => {
  render(<ResultsTable {...props} data={data} isFetching onAddToWatchlist={vi.fn()} />);
  expect(screen.getByText('AVTNPL')).toBeInTheDocument();
  expect(screen.getByRole('status')).toHaveTextContent('Updating results');
  for (const name of ['Copy TradingView', 'Watchlist', 'Next', 'Previous']) expect(screen.getByRole('button', {name})).toBeDisabled();
});

it('uses keyboard-accessible sorting and preserves missing values rather than converting them to zero', () => {
  const sort = vi.fn();
  render(<ResultsTable {...props} data={data} onSortChange={sort} currentSort={{field: 'close', direction: 'asc'}} />);
  expect(screen.getByRole('columnheader', {name: 'Close price'})).toHaveAttribute('aria-sort', 'ascending');
  fireEvent.click(screen.getByRole('button', {name: 'Close price'}));
  expect(sort).toHaveBeenCalledWith('close', 'desc');
  expect(screen.getByText('Unavailable')).toBeInTheDocument();
  expect(screen.getByText('₹94.78')).toBeInTheDocument();
});

it('starts a new page at the top of the internal table, without scrolling the workspace', () => {
  const change = vi.fn();
  render(<ResultsTable {...props} data={data} onPageChange={change} />);
  const scroll = screen.getByLabelText('Equity results table, scroll for more columns');
  scroll.scrollTop = 300;
  fireEvent.click(screen.getByRole('button', {name: 'Next'}));
  expect(scroll.scrollTop).toBe(0);
  expect(change).toHaveBeenCalledWith(2);
});

it('retains previous results only for a page-only change, not a changed filter, sort, universe or release', () => {
  expect(pagePlaceholder(data, request, {...request, page: 2})).toBe(data);
  for (const change of [{datasetRevision: 'b'.repeat(64)}, {asOfDate: '2026-10-08'}, {universe: 'nifty50' as const},
    {sort: {field: 'close', direction: 'asc' as const}}, {textQuery: 'P/E < 20'}, {announcementFilter: {topics: [], window: '7d' as const}},
    {expressionTree: {type: 'group' as const, operator: 'any' as const, children: []}}]) {
    expect(pagePlaceholder(data, request, {...request, ...change, page: 2})).toBeUndefined();
  }
});

it('keeps empty and single-page pagination visible without offering invalid navigation', () => {
  const change = vi.fn();
  const view = render(<Pagination page={1} pageSize={15} total={0} onPageChange={change} />);
  expect(screen.getByText('0-0', {exact: false})).toBeInTheDocument();
  for (const button of within(screen.getByRole('navigation')).getAllByRole('button')) expect(button).toBeDisabled();
  view.rerender(<Pagination page={2} pageSize={15} total={16} onPageChange={change} />);
  fireEvent.click(screen.getByRole('button', {name: 'Previous'}));
  expect(change).toHaveBeenCalledWith(1);
  expect(screen.getByRole('button', {name: 'Next'})).toBeDisabled();
});
