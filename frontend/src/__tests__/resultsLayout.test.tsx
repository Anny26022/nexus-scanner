import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
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

it('leads with quotes only on phones and restores desktop order without changing saved columns', () => {
  localStorage.removeItem('nexus-scanner.screener.columns.v1');
  let notify = () => {};
  const media = {matches:true, addEventListener:vi.fn((_type:string, listener:() => void) => {notify=listener;}), removeEventListener:vi.fn()};
  vi.stubGlobal('matchMedia', () => media);
  try {
    const view = render(<ResultsTable {...props} data={data} />);
    const headings = () => screen.getAllByRole('columnheader').map(header => header.textContent);
    expect(headings().slice(0,3)).toEqual(['Company','Close price','1D return']);
    expect(view.container.querySelector('col')).toHaveStyle({width:'176px'});
    expect(localStorage.getItem('nexus-scanner.screener.columns.v1')).toBeNull();
    act(() => {media.matches=false; notify();});
    expect(headings().slice(0,3)).toEqual(['Company','Sector / industry','Close price']);
    expect(view.container.querySelector('col')).toHaveStyle({width:'24%'});
    view.unmount();
    expect(media.removeEventListener).toHaveBeenCalledWith('change', expect.any(Function));
  } finally {cleanup(); vi.unstubAllGlobals();}
});

it('reuses page slots while replacing company identity, actions, and logo fallback state', () => {
  const view = render(<ResultsTable {...props} data={data} />);
  const firstRow = screen.getByRole('button', {name: 'View AVTNPL announcements'}).closest('tr');
  const logo = firstRow!.querySelector('img')!;
  fireEvent.error(logo);
  expect(logo.src).toContain('stockscans.in');
  view.rerender(<ResultsTable {...props} data={{...data, page: 2, rows: [{...row, symbol: 'WORTHPERI', name: 'Worth Peripherals'}]}} />);
  expect(screen.getByRole('button', {name: 'View WORTHPERI announcements'}).closest('tr')).toBe(firstRow);
  expect(screen.getByRole('button', {name: 'View WORTHPERI company snapshot'})).toBeInTheDocument();
  expect(logo.src).toContain('/WORTHPERI.png');
  expect(screen.queryByRole('button', {name: 'View AVTNPL announcements'})).not.toBeInTheDocument();
});

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
  const view = render(<ResultsTable {...props} data={data} isFetching />);
  expect(screen.getByText('AVTNPL')).toBeInTheDocument();
  expect(screen.getByRole('status')).toHaveTextContent('Updating results');
  expect(screen.queryByRole('button', {name: 'Watchlist'})).not.toBeInTheDocument();
  for (const name of ['Copy TradingView symbols', 'Next', 'Previous']) expect(screen.getByRole('button', {name})).toBeDisabled();
  view.rerender(<ResultsTable {...props} data={{...data, page: 2, matchCount: 45}} isFetching />);
  for (const name of ['Next', 'Previous']) expect(screen.getByRole('button', {name})).toBeDisabled();
});

it('uses keyboard-accessible sorting and preserves missing values rather than converting them to zero', () => {
  const sort = vi.fn();
  render(<ResultsTable {...props} data={data} onSortChange={sort} currentSort={{field: 'close', direction: 'asc'}} />);
  expect(screen.getByRole('columnheader', {name: 'Close price'})).toHaveAttribute('aria-sort', 'ascending');
  expect(screen.getByRole('button', {name: 'View AVTNPL announcements'}).closest('.company-tools')).not.toBeNull();
  fireEvent.click(screen.getByRole('button', {name: 'Close price'}));
  expect(sort).toHaveBeenCalledWith('close', 'desc');
  expect(screen.getByText('Unavailable')).toBeInTheDocument();
  expect(screen.getByText('₹94.78')).toBeInTheDocument();
});

it('persists an added fundamental result column across fresh mounts', () => {
  window.localStorage.removeItem('nexus-scanner.screener.columns.v1');
  const view = render(<ResultsTable {...props} data={data} />);
  fireEvent.click(screen.getByRole('button', {name: 'Customize columns'}));
  expect(screen.getByRole('dialog', {name: 'Customize columns'})).toBeInTheDocument();
  expect(screen.getByRole('heading', {name: 'Customize columns'})).toBeInTheDocument();
  expect(screen.getByText(/7 selected · choose fields for your results table/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('tab', {name: 'Fundamental'}));
  const pe = screen.getByRole('checkbox', {name: 'P/E'});
  expect(pe).not.toBeChecked();
  fireEvent.click(pe);
  expect(screen.getByRole('columnheader', {name: 'P/E'})).toBeInTheDocument();
  expect(view.container.querySelector('colgroup col:nth-child(3)')).toHaveStyle({width: '150px'});
  view.unmount();
  render(<ResultsTable {...props} data={data} />);
  fireEvent.click(screen.getByRole('button', {name: 'Customize columns'}));
  fireEvent.click(screen.getByRole('tab', {name: 'Fundamental'}));
  expect(screen.getByRole('checkbox', {name: 'P/E'})).toBeChecked();
  window.localStorage.removeItem('nexus-scanner.screener.columns.v1');
});

it('selects all available columns from the compact column chooser', () => {
  window.localStorage.removeItem('nexus-scanner.screener.columns.v1');
  const view = render(<ResultsTable {...props} data={data} />);
  fireEvent.click(screen.getByRole('button', {name: 'Customize columns'}));
  fireEvent.click(screen.getByRole('button', {name: 'Select all'}));
  fireEvent.click(screen.getByRole('tab', {name: 'Technical'}));
  expect(screen.getByRole('checkbox', {name: 'SMA10'})).toBeChecked();
  fireEvent.click(screen.getByRole('tab', {name: 'Fundamental'}));
  expect(screen.getByRole('checkbox', {name: 'Revenue (TTM, Cr)'})).toBeChecked();
  const tableScroll = screen.getByLabelText('Equity results table, scroll for more columns');
  Object.defineProperty(tableScroll, 'clientWidth', {value: 1024, configurable: true});
  fireEvent.scroll(tableScroll, {target: {scrollLeft: 16400}});
  expect(screen.getByRole('columnheader', {name: 'Data completeness'})).toBeInTheDocument();
  view.unmount();
  window.localStorage.removeItem('nexus-scanner.screener.columns.v1');
});

it('lets the default table fill its viewport again after resetting a custom column layout', () => {
  window.localStorage.removeItem('nexus-scanner.screener.columns.v1');
  render(<ResultsTable {...props} data={data} />);
  const table = screen.getByRole('table');
  fireEvent.click(screen.getByRole('button', {name: 'Customize columns'}));
  fireEvent.click(screen.getByRole('button', {name: 'Select all'}));
  expect(table.style.width).toMatch(/px$/);
  fireEvent.click(screen.getByRole('button', {name: 'Reset'}));
  expect(table).toHaveStyle({width: '100%', minWidth: '1120px'});
  window.localStorage.removeItem('nexus-scanner.screener.columns.v1');
});

it('searches the full column catalogue across groups', () => {
  window.localStorage.removeItem('nexus-scanner.screener.columns.v1');
  render(<ResultsTable {...props} data={data} />);
  fireEvent.click(screen.getByRole('button', {name: 'Customize columns'}));
  fireEvent.input(screen.getByRole('searchbox', {name: 'Search columns'}), {target: {value: 'P/E'}});
  expect(screen.getAllByRole('checkbox', {name: /P\/E/})).toHaveLength(2);
  expect(screen.queryByRole('tablist', {name: 'Column categories'})).not.toBeInTheDocument();
  window.localStorage.removeItem('nexus-scanner.screener.columns.v1');
});

it('omits surveillance date and refresh-time fields from the column catalogue', () => {
  render(<ResultsTable {...props} data={data} />);
  fireEvent.click(screen.getByRole('button', {name: 'Customize columns'}));
  const search = screen.getByRole('searchbox', {name: 'Search columns'});
  for (const term of ['Surveillance date', 'Surveillance refreshed']) {
    fireEvent.change(search, {target: {value: term}});
    expect(screen.getByText('No matching columns.')).toBeInTheDocument();
  }
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

it('offers compact page sizes without changing pagination itself', () => {
  const change = vi.fn();
  render(<Pagination page={2} pageSize={15} total={200} onPageChange={vi.fn()} onPageSizeChange={change} />);
  fireEvent.change(screen.getByRole('combobox', {name: 'Rows per page'}), {target: {value: '50'}});
  expect(change).toHaveBeenLastCalledWith(50);
  fireEvent.change(screen.getByRole('combobox', {name: 'Rows per page'}), {target: {value: '100'}});
  expect(change).toHaveBeenLastCalledWith(100);
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
  view.rerender(<Pagination page={4} pageSize={15} total={40} onPageChange={change} />);
  expect(screen.getByText('31-40', {exact: false})).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', {name: 'Previous'}));
  expect(change).toHaveBeenLastCalledWith(2);
});
