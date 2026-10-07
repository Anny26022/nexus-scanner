import { fireEvent, render, screen } from '@testing-library/react';
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
