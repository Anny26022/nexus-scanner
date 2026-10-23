import { act, cleanup, fireEvent, render, screen, within, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ResultsTable } from '../components/ResultsTable';
import { ChartEngine } from '../chart/ChartEngine';
import { screenerApi } from '../api/screenerApi';
import { Pagination } from '../components/Pagination';
import { readChartStorage } from '../chart/storage';
import { pagePlaceholder } from '../utils/pagePlaceholder';
import type { ScreenerRunRequest, ScreenerRunResponse, StockRow } from '../types/screener';

vi.mock('../chart/ChartEngine', () => ({ChartEngine: vi.fn(class {
  setStyle=vi.fn(); setEmaLines=vi.fn(); setStudyConfigs=vi.fn(); setStudies=vi.fn(); setBenchmark=vi.fn();
  setAppearance=vi.fn(); setRange=vi.fn(); destroy=vi.fn();
})}));

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.clearAllMocks(); localStorage.removeItem('nexus-scanner.screener.result-view.v1'); localStorage.removeItem('nexus.chart.grid.v1'); });
const request: ScreenerRunRequest = {datasetRevision: 'a'.repeat(64), universe: 'mainboard', asOfDate: '2026-10-09',
  expressionTree: {type: 'group', operator: 'all', children: []}, page: 1, pageSize: 15, sort: {field: 'rvol', direction: 'desc'}};
const row = {symbol: 'AVTNPL', name: 'Avt Natural Products', sector: 'FMCG', industry: 'Agricultural Products',
  close: 94.78, changePct: 10.92, rvol: 19.22, marketCapCrore: 1443, rsRating: 87, rsi14: 57.99, deliveryPct: null} as StockRow;
const data = {rows: [row], matchCount: 16, totalUniverseCount: 2600, page: 1, pageSize: 15, immutableRevision: request.datasetRevision, resolvedSession: {date: request.asOfDate}} as ScreenerRunResponse;
const props = {isLoading: false, isError: false, onPageChange: vi.fn(), onSortChange: vi.fn()};

it('copies every matching symbol from a later page without rendering additional rows', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  Object.defineProperty(navigator, 'clipboard', {configurable:true, value:{writeText}});
  try {
    const matchedSymbols = [...Array.from({length:15}, (_, index) => `MATCH${index + 1}`), 'AVTNPL'];
    render(<ResultsTable {...props} data={{...data, page:2, matchCount:16, matchedSymbols}} />);
    expect(screen.getByRole('button', {name:'Next'})).toBeDisabled();
    expect(screen.getByRole('button', {name:'Previous'})).toBeEnabled();
    fireEvent.click(screen.getByRole('button', {name:'Copy results'}));
    fireEvent.click(screen.getByRole('menuitem', {name:'Symbols'}));
    await waitFor(()=>expect(writeText).toHaveBeenCalledWith(matchedSymbols.map(symbol => `NSE:${symbol}`).join(', ')));
    expect(screen.getAllByRole('row')).toHaveLength(2);
    expect(screen.getByText('AVTNPL')).toBeInTheDocument();
    expect(screen.queryByText('MATCH1')).not.toBeInTheDocument();
    await screen.findByRole('button', {name:'Results copied'});
  } finally {
    if (original) Object.defineProperty(navigator, 'clipboard', original);
    else Reflect.deleteProperty(navigator, 'clipboard');
  }
});

it('reports incomplete legacy results rather than silently copying just the current page', async () => {
  render(<ResultsTable {...props} data={data} />);
  fireEvent.click(screen.getByRole('button', {name:'Copy results'}));
  fireEvent.click(screen.getByRole('menuitem', {name:'Symbols'}));
  expect(await screen.findByRole('alert')).toHaveTextContent('All matching symbols are unavailable');
});

it('switches the current result page into the lazy quick-chart gallery', async () => {
  vi.spyOn(screenerApi, 'getChart').mockRejectedValue(new Error('offline'));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><ResultsTable {...props} data={data} /></QueryClientProvider>);
  fireEvent.click(screen.getByRole('button', { name: 'Charts' }));
  expect(screen.getByText('Interactive charts use your saved style, indicators, and drawings. Drag to pan; scroll or pinch to zoom.')).toBeInTheDocument();
  expect(screen.getByLabelText('AVTNPL quick chart')).toBeInTheDocument();
  await waitFor(() => expect(screenerApi.getChart).toHaveBeenCalledWith('AVTNPL', request.datasetRevision, request.asOfDate));
});

function quickChart(cached = false) {
  let notify!: IntersectionObserverCallback;
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: IntersectionObserverCallback) { notify = callback; }
    observe() {} unobserve() {} disconnect() {}
  });
  const snapshot = {candles: [{date: '2026-10-01', open: 1, high: 2, low: 0.5, close: 1.5, volume: 10}]};
  const getChart = vi.spyOn(screenerApi, 'getChart').mockResolvedValue(snapshot as never);
  const client = new QueryClient({defaultOptions: {queries: {retry: false}}});
  if (cached) client.setQueryData(['chart', request.datasetRevision, row.symbol, request.asOfDate], snapshot);
  const view = render(<QueryClientProvider client={client}><ResultsTable {...props} data={data} /></QueryClientProvider>);
  fireEvent.click(screen.getByRole('button', {name: 'Charts'}));
  const card = screen.getByLabelText('AVTNPL quick chart');
  const intersect = (isIntersecting: boolean) => act(() => notify(
    [{isIntersecting, target: card} as unknown as IntersectionObserverEntry], {} as IntersectionObserver));
  return {...view, client, getChart, intersect};
}

it('reloads a mini chart when the date changes even with the same cached revision', async () => {
  const {client, getChart, intersect, rerender} = quickChart();
  intersect(true);
  await waitFor(() => expect(ChartEngine).toHaveBeenCalledTimes(1));
  const first = vi.mocked(ChartEngine).mock.results[0].value;
  rerender(<QueryClientProvider client={client}><ResultsTable {...props}
    data={{...data, resolvedSession:{...data.resolvedSession, date:'2026-10-08'}}} /></QueryClientProvider>);
  await waitFor(() => expect(getChart).toHaveBeenCalledWith('AVTNPL', request.datasetRevision, '2026-10-08'));
  await waitFor(() => expect(ChartEngine).toHaveBeenCalledTimes(2));
  expect(first.destroy).toHaveBeenCalledTimes(1);
});

it('defers the chart request and engine until the card approaches the viewport', async () => {
  const {getChart, intersect} = quickChart();
  expect(getChart).not.toHaveBeenCalled();
  expect(ChartEngine).not.toHaveBeenCalled();
  intersect(true);
  await waitFor(() => expect(ChartEngine).toHaveBeenCalledTimes(1));
  expect(getChart).toHaveBeenCalledWith('AVTNPL', request.datasetRevision, request.asOfDate);
});

it('defers a cached chart engine until the card approaches the viewport', async () => {
  const {getChart, intersect} = quickChart(true);
  expect(ChartEngine).not.toHaveBeenCalled();
  intersect(true);
  await waitFor(() => expect(ChartEngine).toHaveBeenCalledTimes(1));
  expect(getChart).not.toHaveBeenCalled();
});

it('retains the engine and canvas across viewport exit and List/Charts switches', async () => {
  const {container, intersect, unmount} = quickChart();
  intersect(true);
  await waitFor(() => expect(ChartEngine).toHaveBeenCalledTimes(1));
  const engine = vi.mocked(ChartEngine).mock.results[0].value;
  const canvas = container.querySelector('.quick-chart-canvas');
  intersect(false);
  fireEvent.click(screen.getByRole('button', {name: 'List'}));
  fireEvent.click(screen.getByRole('button', {name: 'Charts'}));
  intersect(true);
  expect(container.querySelector('.quick-chart-canvas')).toBe(canvas);
  expect(ChartEngine).toHaveBeenCalledTimes(1);
  expect(engine.destroy).not.toHaveBeenCalled();
  unmount();
  expect(engine.destroy).toHaveBeenCalledTimes(1);
});

it('opens a quick chart in the existing full chart workspace', () => {
  const openFullChart = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><ResultsTable {...props} data={data} onOpenFullChart={openFullChart} /></QueryClientProvider>);
  fireEvent.click(screen.getByRole('button', { name: 'Charts' }));
  fireEvent.click(screen.getByRole('button', { name: 'Open AVTNPL full chart' }));
  expect(openFullChart).toHaveBeenCalledWith('AVTNPL', request.datasetRevision, request.asOfDate);
  expect((readChartStorage('grid.v1') as { tiles: Array<{ symbol: string; interval: string }> }).tiles[0]).toEqual({ symbol: 'AVTNPL', interval: 'D' });
});

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
  for (const name of ['Copy results', 'Next', 'Previous']) expect(screen.getByRole('button', {name})).toBeDisabled();
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
  expect(screen.getByRole('columnheader', {name: 'P/E', hidden: true})).toBeInTheDocument();
  expect(view.container.querySelector('colgroup col:nth-child(3)')).toHaveStyle({width: '150px'});
  view.unmount();
  render(<ResultsTable {...props} data={data} />);
  fireEvent.click(screen.getByRole('button', {name: 'Customize columns'}));
  fireEvent.click(screen.getByRole('tab', {name: 'Fundamental'}));
  expect(screen.getByRole('checkbox', {name: 'P/E'})).toBeChecked();
  window.localStorage.removeItem('nexus-scanner.screener.columns.v1');
});

it('clips long custom column headers within their cells while retaining the full label', () => {
  window.localStorage.setItem('nexus-scanner.screener.columns.v1', JSON.stringify(['company', 'currentLiabilitiesLakh', 'nonCurrentLiabilitiesLakh']));
  render(<ResultsTable {...props} data={data} />);
  expect(screen.getByRole('columnheader', {name: 'Current liabilities (Lakh)'})).toHaveAttribute('title', 'Current liabilities (Lakh)');
  expect(screen.getByRole('columnheader', {name: 'Non-current liabilities (Lakh)'})).toHaveAttribute('title', 'Non-current liabilities (Lakh)');
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
  expect(screen.getByRole('columnheader', {name: 'Data completeness', hidden: true})).toBeInTheDocument();
  view.unmount();
  window.localStorage.removeItem('nexus-scanner.screener.columns.v1');
});

it('keeps company and filing controls mounted when a wide phone table is swiped to its end', () => {
  localStorage.removeItem('nexus-scanner.screener.columns.v1');
  vi.stubGlobal('matchMedia', () => ({matches:true,addEventListener:vi.fn(),removeEventListener:vi.fn()}));
  try {
    const manyRows = Array.from({length:100}, (_, index) => ({...row,symbol:`STOCK${index}`}));
    const view = render(<ResultsTable {...props} data={{...data,rows:manyRows,pageSize:100,matchCount:100}} />);
    fireEvent.click(screen.getByRole('button', {name:'Customize columns'}));
    fireEvent.click(screen.getByRole('button', {name:'Select all'}));
    fireEvent.click(screen.getByRole('button', {name:'Close column customization'}));
    const count = screen.getAllByRole('columnheader').length;
    expect(count).toBeGreaterThan(20);
    const tableScroll = screen.getByLabelText('Equity results table, scroll for more columns');
    Object.defineProperty(tableScroll,'clientWidth',{value:390,configurable:true});
    fireEvent.scroll(tableScroll, {target:{scrollLeft:16400}});
    expect(screen.getAllByRole('columnheader')).toHaveLength(count);
    expect(screen.getByRole('columnheader', {name:'Company'})).toBeInTheDocument();
    expect(screen.getByRole('button', {name:'View STOCK0 company snapshot'})).toBeInTheDocument();
    expect(screen.getByRole('button', {name:'View STOCK0 announcements'})).toBeInTheDocument();
    expect(screen.getByRole('columnheader', {name:'Data completeness'})).toBeInTheDocument();
    // Vertical row windowing is still bounded, even with every column selected.
    expect(view.container.querySelectorAll('tbody tr:not(.table-spacer)')).toHaveLength(22);
  } finally {cleanup(); vi.unstubAllGlobals(); localStorage.removeItem('nexus-scanner.screener.columns.v1');}
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

it('propagates result view toggle via onResultViewChange callback', () => {
  const onResultViewChange = vi.fn();
  render(<ResultsTable {...props} data={data} resultView="table" onResultViewChange={onResultViewChange} />);
  fireEvent.click(screen.getByRole('button', { name: 'Charts' }));
  expect(onResultViewChange).toHaveBeenCalledWith('charts');
});
