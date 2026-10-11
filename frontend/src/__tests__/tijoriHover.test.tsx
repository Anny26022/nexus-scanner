import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { ResultsTable } from '../components/ResultsTable';
import { getTijoriOverviews } from '../api/tijori';
import type { ScreenerRunResponse, StockRow } from '../types/screener';

vi.mock('../api/tijori', () => ({getTijoriOverviews: vi.fn()}));
afterEach(() => {cleanup(); vi.clearAllMocks();});
const data = {rows: [{symbol: 'TEST', name: 'Test company', close: 100} as StockRow],
  matchCount: 1, totalUniverseCount: 2600, page: 1, pageSize: 15} as ScreenerRunResponse;
const props = {data, isLoading: false, isError: false, onPageChange: vi.fn(), onSortChange: vi.fn()};
const report = {name: 'Test company', sourceUrl: 'https://www.tijorifinance.com/company/test/', as_of: '2026-10-01',
  the_read: ['Makes industrial equipment.'], what_to_watch: [{title: 'New factory', window: 'FY27', body: 'Watch commissioning progress.'}], key_events: []};
function mount() {
  const client = new QueryClient({defaultOptions: {queries: {retry: false}}});
  return render(<QueryClientProvider client={client}><ResultsTable {...props} /></QueryClientProvider>);
}

it('loads on symbol hover, hides empty tabs, supports keyboard tabs and reuses cached reports', async () => {
  vi.mocked(getTijoriOverviews).mockResolvedValue({TEST: report});
  mount();
  expect(getTijoriOverviews).not.toHaveBeenCalled();
  const trigger = screen.getByRole('button', {name: 'View TEST company snapshot'});
  fireEvent.mouseEnter(trigger);
  expect(await screen.findByText('Makes industrial equipment.')).toBeInTheDocument();
  expect(screen.queryByRole('tab', {name: 'Key events'})).not.toBeInTheDocument();
  fireEvent.keyDown(screen.getByRole('tab', {name: 'Snapshot'}), {key: 'ArrowRight'});
  expect(screen.getByRole('tab', {name: 'What to Watch'})).toHaveFocus();
  expect(screen.getByText('Watch commissioning progress.')).toBeInTheDocument();
  fireEvent.keyDown(document, {key: 'Escape'});
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
  fireEvent.mouseEnter(trigger);
  expect(await screen.findByText('Makes industrial equipment.')).toBeInTheDocument();
  expect(getTijoriOverviews).toHaveBeenCalledTimes(1);
});

it('allows pointer travel into the panel and closes when the table scrolls', async () => {
  vi.mocked(getTijoriOverviews).mockResolvedValue({TEST: report});
  mount();
  const trigger = screen.getByRole('button', {name: 'View TEST company snapshot'});
  fireEvent.mouseEnter(trigger);
  await screen.findByText('Makes industrial equipment.');
  fireEvent.mouseLeave(trigger);
  fireEvent.mouseEnter(screen.getByRole('dialog'));
  await new Promise(resolve => setTimeout(resolve, 220));
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  fireEvent.scroll(screen.getByLabelText('Equity results table, scroll for more columns'));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

it('offers a contextual empty state for an uncovered symbol', async () => {
  vi.mocked(getTijoriOverviews).mockResolvedValue({});
  mount();
  fireEvent.click(screen.getByRole('button', {name: 'View TEST company snapshot'}));
  expect(await screen.findByText('No Tijori snapshot is available for this company.')).toBeInTheDocument();
  expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
  fireEvent.pointerDown(document.body);
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
});
