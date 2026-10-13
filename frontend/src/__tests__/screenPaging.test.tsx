import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { ExploreTab } from '../components/ExploreTab';
import { screenerApi } from '../api/screenerApi';
import type { ScreenerRunRequest, ScreenerRunResponse, StockRow } from '../types/screener';

vi.mock('../api/screenerApi', () => ({screenerApi: {runScreen: vi.fn()}}));
afterEach(() => {cleanup(); localStorage.clear(); vi.clearAllMocks();});
const revision = 'a'.repeat(64);
function result(request: ScreenerRunRequest): ScreenerRunResponse {
  const symbol = request.page === 1 ? 'AVTNPL' : 'WORTHPERI';
  return {rows: [{symbol, name: symbol, sector: 'Industrials', industry: 'Equipment', close: 100, changePct: 1, rvol: 2, deliveryPct: null} as StockRow],
    page: request.page, pageSize: request.pageSize, matchCount: 16, totalUniverseCount: 2600, immutableRevision: request.datasetRevision} as ScreenerRunResponse;
}
function setup() {
  const client = new QueryClient({defaultOptions: {queries: {retry: false}}});
  const refresh = vi.fn().mockResolvedValue(revision);
  const app = (selected = revision) => <QueryClientProvider client={client}><ExploreTab selectedAsOfDate="2026-10-09" datasetRevision={selected} onRefreshRevision={refresh} /></QueryClientProvider>;
  return {app, client, view: render(app())};
}

it('retains a disabled prior page during paging, then displays the correct new page', async () => {
  let finish!: (value: ScreenerRunResponse) => void;
  let next!: ScreenerRunRequest;
  vi.mocked(screenerApi.runScreen).mockImplementationOnce(async request => result(request))
    .mockImplementationOnce(request => {next = request; return new Promise(resolve => {finish = resolve;});});
  setup();
  expect(await screen.findByText('AVTNPL', {selector: 'b'})).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', {name: 'Next'}));
  await waitFor(() => expect(next.page).toBe(2));
  expect(screen.getByText('Updating results')).toHaveAttribute('role', 'status');
  expect(screen.getByRole('button', {name: 'Next'})).toBeDisabled();
  expect(screen.getByText('AVTNPL', {selector: 'b'})).toBeInTheDocument();
  await act(async () => finish(result(next)));
  expect(await screen.findByText('WORTHPERI', {selector: 'b'})).toBeInTheDocument();
  expect(screen.getByRole('button', {name: 'Next'})).toBeDisabled();
  expect(screen.getByRole('button', {name: 'Previous'})).toBeEnabled();
});

it('searching symbols resets pagination and preserves the active screen criteria', async () => {
  vi.mocked(screenerApi.runScreen).mockImplementation(async request => result(request));
  setup();
  await screen.findByText('AVTNPL', {selector:'b'});
  fireEvent.click(screen.getByRole('button', {name:'Next'}));
  await screen.findByText('WORTHPERI', {selector:'b'});
  fireEvent.change(screen.getByRole('searchbox', {name:'Search symbol or company'}), {target:{value:'glaxo'}});
  await waitFor(() => expect(screenerApi.runScreen).toHaveBeenCalledWith(expect.objectContaining({symbolSearch:'glaxo', page:1})));
  const searched = vi.mocked(screenerApi.runScreen).mock.calls.find(([request]) => request.symbolSearch === 'glaxo')![0];
  expect(searched.expressionTree).toEqual(vi.mocked(screenerApi.runScreen).mock.calls[0][0].expressionTree);
});

it('resets to the first page of a new release, while preserving the screen criteria', async () => {
  vi.mocked(screenerApi.runScreen).mockImplementation(async request => result(request));
  const {app, view} = setup();
  await screen.findByText('AVTNPL', {selector: 'b'});
  fireEvent.click(screen.getByRole('button', {name: 'Next'}));
  await screen.findByText('WORTHPERI', {selector: 'b'});
  view.rerender(app('b'.repeat(64)));
  await waitFor(() => expect(vi.mocked(screenerApi.runScreen).mock.lastCall?.[0]).toMatchObject({datasetRevision: 'b'.repeat(64), page: 1}));
  expect(vi.mocked(screenerApi.runScreen).mock.lastCall?.[0].expressionTree).toEqual(vi.mocked(screenerApi.runScreen).mock.calls[0][0].expressionTree);
});

it('closing the filter editor does not apply drafts, reset criteria or rerun the screen', async () => {
  vi.mocked(screenerApi.runScreen).mockImplementation(async request => result(request));
  setup();
  await screen.findByText('AVTNPL', {selector: 'b'});
  await waitFor(() => expect(screenerApi.runScreen).toHaveBeenCalledTimes(2));
  fireEvent.click(screen.getByRole('button', {name: 'Filters 2'}));
  fireEvent.change(screen.getByRole('spinbutton', {name: 'Max P/E'}), {target: {value: '20'}});
  fireEvent.click(screen.getByRole('button', {name: 'Close filters'}));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.getByRole('button', {name: 'Filters 2'})).toBeInTheDocument();
  expect(screenerApi.runScreen).toHaveBeenCalledTimes(2);
});

it('warms the next 100-row page and reuses visited pages without querying again', async () => {
  vi.mocked(screenerApi.runScreen).mockImplementation(async request => ({...result(request), matchCount: 201}));
  const {client} = setup();
  await screen.findByText('AVTNPL', {selector: 'b'});
  fireEvent.change(screen.getByRole('combobox', {name: 'Rows per page'}), {target: {value: '100'}});
  await waitFor(() => expect(client.getQueryCache().getAll().some(query => {
    const request = query.queryKey[1] as ScreenerRunRequest;
    return request?.pageSize === 100 && request.page === 2 && query.state.status === 'success';
  })).toBe(true));
  fireEvent.click(screen.getByRole('button', {name: 'Next'}));
  expect(screen.getByText('WORTHPERI', {selector: 'b'})).toBeInTheDocument();
  expect(screen.queryByText('Updating results')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', {name: 'Previous'}));
  expect(screen.getByText('AVTNPL', {selector: 'b'})).toBeInTheDocument();
  for (const page of [1, 2]) expect(vi.mocked(screenerApi.runScreen).mock.calls.filter(([request]) =>
    request.page === page && request.pageSize === 100)).toHaveLength(1);
});
