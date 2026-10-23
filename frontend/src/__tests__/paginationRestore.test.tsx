import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('../api/screenerApi', () => ({screenerApi: {runScreen: vi.fn(), getIpoCatalogue: vi.fn()}}));
import { screenerApi } from '../api/screenerApi';
import { ExploreTab } from '../components/ExploreTab';
import { NewListingsTab } from '../components/NewListingsTab';
import type { ScreenerRunRequest, ScreenerRunResponse } from '../types/screener';

afterEach(() => {cleanup(); localStorage.clear(); vi.clearAllMocks();});

const revision = 'a'.repeat(64);

function result(request: ScreenerRunRequest): ScreenerRunResponse {
  const symbol = request.page === 1 ? 'AVTNPL' : 'WORTHPERI';
  return {rows: [{symbol, name: symbol, sector: 'Industrials', industry: 'Equipment', close: 100, changePct: 1, rvol: 2, deliveryPct: null}],
    page: request.page, pageSize: request.pageSize, matchCount: 66, totalUniverseCount: 2600, immutableRevision: request.datasetRevision} as ScreenerRunResponse;
}

function renderScreener() {
  const client = new QueryClient({defaultOptions: {queries: {retry: false}}});
  return render(<QueryClientProvider client={client}><ExploreTab selectedAsOfDate="2026-10-09" datasetRevision={revision} onRefreshRevision={async () => revision} availableSessions={[]} /></QueryClientProvider>);
}

function rowsPerPage() {
  return (screen.getByRole('combobox', {name: 'Rows per page'}) as HTMLSelectElement).value;
}

function pageIndicator(container: HTMLElement) {
  return container.querySelector('.pagination-page')?.textContent ?? '';
}

it('renders the saved page size and page before the screener response arrives', async () => {
  localStorage.setItem('nexus-scanner.screener.pagination.v1', JSON.stringify({revision, page: 2, pageSize: 50}));
  let resolve!: (value: ScreenerRunResponse) => void;
  vi.mocked(screenerApi.runScreen).mockImplementation(() => new Promise(done => {resolve = done;}));
  const {container} = renderScreener();
  expect(rowsPerPage()).toBe('50');
  expect(pageIndicator(container)).toContain('2');
  await waitFor(() => expect(vi.mocked(screenerApi.runScreen).mock.lastCall?.[0]).toMatchObject({datasetRevision: revision, page: 2, pageSize: 50}));
  await act(async () => resolve(result({page: 2, pageSize: 50, datasetRevision: revision} as ScreenerRunRequest)));
  expect(rowsPerPage()).toBe('50');
  expect(pageIndicator(container)).toContain('2');
});

it('keeps the page indicator on the page whose rows are visible while the next page loads', async () => {
  const pending: ((value: ScreenerRunResponse) => void)[] = [];
  vi.mocked(screenerApi.runScreen).mockImplementation(request => {
    if (request.page === 1) return Promise.resolve(result(request));
    return new Promise(done => {pending.push(done);});
  });
  const {container} = renderScreener();
  await screen.findByText('AVTNPL', {selector: 'b'});
  fireEvent.click(screen.getByRole('button', {name: 'Next'}));
  await screen.findByText('Updating results');
  expect(pageIndicator(container)).toContain('1');
  await act(async () => pending.forEach(done => done(result({page: 2, pageSize: 15, datasetRevision: revision} as ScreenerRunRequest))));
  await screen.findByText('WORTHPERI', {selector: 'b'});
  expect(pageIndicator(container)).toContain('2');
});

it('falls back to the default pagination when the stored value is corrupt', async () => {
  localStorage.setItem('nexus-scanner.screener.pagination.v1', 'null');
  vi.mocked(screenerApi.runScreen).mockImplementation(async request => result(request));
  const {container} = renderScreener();
  expect(rowsPerPage()).toBe('15');
  expect(pageIndicator(container)).toContain('1');
  await waitFor(() => expect(vi.mocked(screenerApi.runScreen).mock.lastCall?.[0]).toMatchObject({page: 1, pageSize: 15}));
});

it('clears incompatible rules when switching between stock and ETF universes', async () => {
  localStorage.setItem('nexus-scanner.screener.query.v1', JSON.stringify('PE < 20'));
  vi.mocked(screenerApi.runScreen).mockImplementation(async request => result(request));
  renderScreener();
  const universe = screen.getByRole('combobox', {name:'Stock universe'});
  fireEvent.change(universe, {target:{value:'etf'}});
  await waitFor(() => expect(vi.mocked(screenerApi.runScreen).mock.lastCall?.[0]).toMatchObject({
    universe:'etf', textQuery:undefined, sort:{field:'symbol',direction:'asc'},
    expressionTree:{children:[]},
  }));
  expect(screen.getByRole('textbox', {name:'Scanner query'})).toBeDisabled();
  expect(screen.queryByRole('button', {name:'Ask AI'})).not.toBeInTheDocument();
  fireEvent.change(universe, {target:{value:'mainboard'}});
  await waitFor(() => expect(vi.mocked(screenerApi.runScreen).mock.lastCall?.[0].universe).toBe('mainboard'));
  expect(screen.getByRole('textbox', {name:'Scanner query'})).toBeEnabled();
  expect(screen.getByRole('button', {name:'Ask AI'})).toBeInTheDocument();
});

it('shows the saved IPO rows per page before the catalogue loads', () => {
  localStorage.setItem('nexus-scanner.ipo.pagination.v1', JSON.stringify({revision, page: 2, pageSize: 100}));
  vi.mocked(screenerApi.getIpoCatalogue).mockImplementation(() => new Promise(() => {}));
  const client = new QueryClient({defaultOptions: {queries: {retry: false}}});
  render(<QueryClientProvider client={client}><NewListingsTab datasetRevision={revision} selectedAsOfDate="2026-10-09" /></QueryClientProvider>);
  expect(rowsPerPage()).toBe('100');
});
