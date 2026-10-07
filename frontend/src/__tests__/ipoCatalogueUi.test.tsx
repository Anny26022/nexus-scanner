import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

vi.mock('../api/screenerApi', () => ({screenerApi: {getIpoCatalogue: vi.fn()}}));
import { screenerApi } from '../api/screenerApi';
import { NewListingsTab } from '../components/NewListingsTab';

afterEach(() => { cleanup(); vi.clearAllMocks(); localStorage.clear(); });

it('shows fetch failure and allows retry instead of reporting no listings', async () => {
  vi.mocked(screenerApi.getIpoCatalogue).mockRejectedValueOnce(new Error('network unavailable'))
    .mockResolvedValueOnce({records: [], providerStatus: {checkedAt: null, state: 'retained'}});
  const client = new QueryClient({defaultOptions: {queries: {retry: false}}});
  render(<QueryClientProvider client={client}><NewListingsTab datasetRevision={'a'.repeat(64)} selectedAsOfDate="2026-10-06" /></QueryClientProvider>);
  expect(await screen.findByRole('alert')).toHaveTextContent('IPO catalogue could not be loaded');
  expect(screen.queryByText(/No new listings/)).not.toBeInTheDocument();
  expect(screen.queryByText(/0 listings/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', {name: 'Retry'}));
  expect(await screen.findByText(/refresh failed; retained data shown/)).toBeInTheDocument();
  expect(await screen.findByText(/No new listings/)).toBeInTheDocument();
});


it('keeps loaded listings and their count visible after a failed refetch', async () => {
  const revision = 'b'.repeat(64);
  vi.mocked(screenerApi.getIpoCatalogue).mockResolvedValueOnce({records: [{
    symbol: 'TEST', name: 'Example Industries', listingDate: '2026-10-01',
    currentPrice: 110, turnoverCrore: 1, deliveryPct: null,
    sector: 'Industrials', industry: 'Equipment', marketCapCrore: 100,
  }]}).mockRejectedValueOnce(new Error('network unavailable'));
  const client = new QueryClient({defaultOptions: {queries: {retry: false}}});
  render(<QueryClientProvider client={client}><NewListingsTab datasetRevision={revision} selectedAsOfDate="2026-10-06" /></QueryClientProvider>);
  expect(await screen.findByText('Example Industries')).toBeInTheDocument();
  await act(async () => { await client.refetchQueries({queryKey: ['ipos', revision]}); });
  await waitFor(() => expect(client.getQueryState(['ipos', revision])?.status).toBe('error'));
  expect(screen.getByText('Example Industries')).toBeInTheDocument();
  expect(screen.getByText('1 listings')).toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(screen.queryByText(/No new listings/)).not.toBeInTheDocument();
});
