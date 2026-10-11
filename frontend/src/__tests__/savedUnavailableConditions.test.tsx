import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { ExploreTab } from '../components/ExploreTab';
import { NewListingsTab } from '../components/NewListingsTab';
import { screenerApi } from '../api/screenerApi';
import type { ActiveCondition } from '../types/screener';

vi.mock('../api/screenerApi', () => ({screenerApi: {runScreen: vi.fn(), getIpoCatalogue: vi.fn()}}));
afterEach(() => {cleanup(); localStorage.clear(); vi.clearAllMocks();});

const saved: Record<string, ActiveCondition> = {
  old: {instanceId: 'old', conditionId: 'MA_CONVERGENCE', parameters: {periods: '9,20,50'}},
  mom_rvol: {instanceId: 'rvol', conditionId: 'mom_rvol', parameters: {minRvol: 2, maxRvol: 20}},
};

it.each(['screener', 'ipo'] as const)('preserves saved unavailable filters and blocks %s scans until explicit removal', async mode => {
  const storageKey = `nexus-scanner.${mode}.conditions.v1`;
  localStorage.setItem(storageKey, JSON.stringify(saved));
  vi.mocked(screenerApi.runScreen).mockImplementation(async request => ({
    rows: [], matchCount: 0, totalUniverseCount: 1, page: request.page, pageSize: request.pageSize,
    immutableRevision: request.datasetRevision!,
    resolvedSession: {date: request.asOfDate, sessionId: request.asOfDate, status: 'closed', isHistorical: false},
    perConditionCoverage: {}, unavailableDiagnostics: [], warnings: [],
  }));
  vi.mocked(screenerApi.getIpoCatalogue).mockResolvedValue({records: [{
    symbol: 'EXAMPLE', name: 'Example', listingDate: '2026-10-01', currentPrice: 100,
    turnoverCrore: 1, marketCapCrore: 100, deliveryPct: null, sector: 'Industrials', industry: 'Equipment',
  }]});
  const client = new QueryClient({defaultOptions: {queries: {retry: false}}});
  render(<QueryClientProvider client={client}>{mode === 'screener'
    ? <ExploreTab selectedAsOfDate="2026-10-09" datasetRevision={'a'.repeat(64)} onRefreshRevision={vi.fn()} />
    : <NewListingsTab selectedAsOfDate="2026-10-09" datasetRevision={'a'.repeat(64)} />}</QueryClientProvider>);
  expect(screen.getByRole('alert')).toHaveTextContent('Saved filters are unavailable');
  expect(screen.getByRole('button', {name: 'Run'})).toBeDisabled();
  fireEvent.click(screen.getByRole('button', {name: 'Run'}));
  expect(screenerApi.runScreen).not.toHaveBeenCalled();
  expect(JSON.parse(localStorage.getItem(storageKey)!)).toEqual(saved);
  fireEvent.click(screen.getByRole('button', {name: 'Filters 2'}));
  let dialog = within(screen.getByRole('dialog'));
  expect(screen.getByRole('dialog').querySelector('.dialog-footer')).toHaveTextContent('2 selected');
  expect(dialog.getByRole('button', {name: 'Apply'})).toBeDisabled();
  fireEvent.click(dialog.getByRole('button', {name: 'Remove unavailable MA Convergence'}));
  expect(dialog.getByText('1 selected')).toBeInTheDocument();
  // Closing discards the draft removal, preserving the saved constraint.
  fireEvent.click(dialog.getByRole('button', {name: 'Close filters'}));
  expect(JSON.parse(localStorage.getItem(storageKey)!)).toEqual(saved);
  expect(screen.getByRole('button', {name: 'Run'})).toBeDisabled();
  fireEvent.click(screen.getByRole('button', {name: 'Filters 2'}));
  dialog = within(screen.getByRole('dialog'));
  fireEvent.click(dialog.getByRole('button', {name: 'Remove unavailable MA Convergence'}));
  fireEvent.click(dialog.getByRole('button', {name: 'Apply'}));
  await waitFor(() => expect(screenerApi.runScreen).toHaveBeenCalled());
  expect(JSON.parse(localStorage.getItem(storageKey)!)).toEqual({mom_rvol: saved.mom_rvol});
  expect(vi.mocked(screenerApi.runScreen).mock.lastCall?.[0].expressionTree).toEqual({
    type: 'group', operator: 'all', children: [{type: 'condition', condition: saved.mom_rvol}],
  });
});
