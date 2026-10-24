import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { ResultsTable } from '../components/ResultsTable';
import { getCompanySnapshots } from '../api/companySnapshots';
import type { ScreenerRunResponse, StockRow } from '../types/screener';

vi.mock('../api/companySnapshots', () => ({getCompanySnapshots: vi.fn()}));
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
  vi.mocked(getCompanySnapshots).mockResolvedValue({TEST: report});
  mount();
  expect(getCompanySnapshots).not.toHaveBeenCalled();
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
  expect(getCompanySnapshots).toHaveBeenCalledTimes(1);
});

it('allows pointer travel into the panel and closes when the table scrolls', async () => {
  vi.mocked(getCompanySnapshots).mockResolvedValue({TEST: report});
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
  vi.mocked(getCompanySnapshots).mockResolvedValue({});
  mount();
  fireEvent.click(screen.getByRole('button', {name: 'View TEST company snapshot'}));
  expect(await screen.findByText('No snapshot is available for this company.')).toBeInTheDocument();
  expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
  fireEvent.pointerDown(document.body);
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
});

it.each(['ArrowDown', 'Enter', ' '])('enters the portal with %s and restores trigger focus on close', async key => {
  vi.mocked(getCompanySnapshots).mockResolvedValue({TEST:report});
  mount();
  const trigger = screen.getByRole('button', {name:'View TEST company snapshot'});
  fireEvent.keyDown(trigger, {key});
  const close = await screen.findByRole('button', {name:'Close company snapshot'});
  expect(close).toHaveFocus();
  await screen.findByText('Makes industrial equipment.');
  fireEvent.click(close);
  expect(trigger).toHaveFocus();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

it('keeps tapped cards open during scrolling and repositions them after resize', async () => {
  vi.mocked(getCompanySnapshots).mockResolvedValue({TEST: report});
  const media = {matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn()};
  vi.stubGlobal('matchMedia', () => media);
  vi.stubGlobal('innerWidth', 390);
  try {
    mount();
    const trigger = screen.getByRole('button', {name: 'View TEST company snapshot'});
    fireEvent.click(trigger);
    expect(await screen.findByText('Makes industrial equipment.')).toBeInTheDocument();
    fireEvent.scroll(screen.getByLabelText('Equity results table, scroll for more columns'));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('dialog').style.left).toBe('12px');
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({left: 200, right: 350, top: 100} as DOMRect);
    vi.stubGlobal('innerWidth', 1024);
    fireEvent.resize(window);
    expect(screen.getByRole('dialog').style.left).toBe('364px');
    expect(screen.getByRole('dialog').style.top).toBe('88px');
  } finally {
    vi.unstubAllGlobals();
  }
});
