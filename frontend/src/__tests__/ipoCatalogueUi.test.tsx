import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

vi.mock('../api/screenerApi', () => ({screenerApi: {getIpoCatalogue: vi.fn()}}));
import { screenerApi } from '../api/screenerApi';
import { NewListingsTab } from '../components/NewListingsTab';

afterEach(() => { cleanup(); vi.clearAllMocks(); localStorage.clear(); });

it.each([
  {saved:null, desktop:['Company','Sector / industry','Listing date','Last price','Daily turnover','Market cap','Delivery'],
    phone:['Company','Last price','Listing date','Sector / industry','Daily turnover','Market cap','Delivery']},
  {saved:['company','currentPrice','issuePrice','listingDate'], desktop:['Company','Listing date','Last price','Issue price'],
    phone:['Company','Last price','Listing date','Issue price']},
])('preserves IPO column preferences and desktop order through phone switches ($saved)', async ({saved, desktop, phone}) => {
  const key = 'nexus-scanner.ipo.columns.v1';
  if (saved) localStorage.setItem(key, JSON.stringify(saved));
  const stored = localStorage.getItem(key);
  let notify = () => {};
  const media = {matches:false,addEventListener:vi.fn((_type:string,listener:() => void) => {notify=listener;}),removeEventListener:vi.fn()};
  vi.stubGlobal('matchMedia', () => media);
  try {
    vi.mocked(screenerApi.getIpoCatalogue).mockResolvedValueOnce({records:[{
      symbol:'TEST',name:'Test IPO',listingDate:'2026-10-01',currentPrice:100,
      turnoverCrore:1,marketCapCrore:200,sector:'Industrials',industry:'Equipment',
    }]});
    const client = new QueryClient({defaultOptions:{queries:{retry:false}}});
    render(<QueryClientProvider client={client}><NewListingsTab datasetRevision={'d'.repeat(64)} selectedAsOfDate="2026-10-09" /></QueryClientProvider>);
    await screen.findByRole('button', {name:'IPO details for Test IPO'});
    const headings = () => screen.getAllByRole('columnheader').map(header=>header.textContent);
    expect(headings()).toEqual(desktop);
    expect(localStorage.getItem(key)).toBe(stored);
    act(() => {media.matches=true; notify();});
    expect(headings()).toEqual(phone);
    expect(localStorage.getItem(key)).toBe(stored);
    act(() => {media.matches=false; notify();});
    expect(headings()).toEqual(desktop);
    expect(localStorage.getItem(key)).toBe(stored);
  } finally {cleanup(); vi.unstubAllGlobals();}
});

it('lets keyboard users enter the IPO card and returns focus on Escape', async () => {
  vi.mocked(screenerApi.getIpoCatalogue).mockResolvedValueOnce({records: [{
    symbol: 'TEST', name: 'Test IPO', listingDate: '2026-10-01', currentPrice: 100,
    turnoverCrore: 1, marketCapCrore: 200, sector: 'Industrials', industry: 'Equipment',
  }]});
  const client = new QueryClient({defaultOptions: {queries: {retry: false}}});
  render(<QueryClientProvider client={client}><NewListingsTab datasetRevision={'d'.repeat(64)} selectedAsOfDate="2026-10-09" /></QueryClientProvider>);
  const company = await screen.findByRole('button', {name: 'IPO details for Test IPO'});
  act(() => company.focus());
  fireEvent.keyDown(company, {key: 'Tab'});
  expect(screen.getByRole('button', {name: 'Close IPO details'})).toHaveFocus();
  fireEvent.mouseLeave(company);
  await act(() => new Promise(resolve => setTimeout(resolve, 220)));
  const card = screen.getByRole('dialog', {name: 'Test IPO IPO details'});
  expect(card).toBeInTheDocument();
  fireEvent.keyDown(card, {key: 'Escape'});
  expect(screen.queryByRole('dialog', {name: 'Test IPO IPO details'})).not.toBeInTheDocument();
  expect(company).toHaveFocus();
});

it('shows fetch failure and allows retry instead of reporting no listings', async () => {
  vi.mocked(screenerApi.getIpoCatalogue).mockRejectedValueOnce(new Error('network unavailable'))
    .mockResolvedValueOnce({records: [], providerStatus: {checkedAt: null, state: 'retained'}});
  const client = new QueryClient({defaultOptions: {queries: {retry: false}}});
  render(<QueryClientProvider client={client}><NewListingsTab datasetRevision={'a'.repeat(64)} selectedAsOfDate="2026-10-06" /></QueryClientProvider>);
  expect(await screen.findByRole('alert')).toHaveTextContent('IPO catalogue could not be loaded');
  expect(screen.queryByText(/No new listings/)).not.toBeInTheDocument();
  expect(screen.queryByText(/0 listings/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', {name: 'Retry'}));
  expect(await screen.findByText(/No new listings/)).toBeInTheDocument();
  expect(screen.queryByText(/catalogue and analytics refreshed|refresh failed|Checked .*IST/)).not.toBeInTheDocument();
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
  expect(screen.getByRole('region', {name: 'IPO listings'}).querySelector('.result-count')).toHaveTextContent(/^1new listings$/);
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(screen.queryByText(/No new listings/)).not.toBeInTheDocument();
});

it('opens the company IPO research card on hover and allows it to stay open by click', async () => {
  vi.mocked(screenerApi.getIpoCatalogue).mockResolvedValueOnce({records: [{
    symbol: 'RUNWALENTR', name: 'Runwal Enterprises', listingDate: '2026-10-05',
    currentPrice: 262.55, turnoverCrore: 11.2, deliveryPct: 40.54,
    sector: 'Unclassified', industry: 'Unclassified', marketCapCrore: 3880,
    issuePrice: 302,
    ipoDetailStatus: {lastSuccessAt: null, failedEndpoints: []},
    ipoResearch: {
      issuePrice: 302,
      offer: {issueSizeCrore: 365.76, freshIssueCrore: 499.83},
      subscription: {total: 2.5, retail: 1.12, nii: 3.93},
      provider: {listingPrice: 298.95, listingGainPct: -1.98, gmp: -5, gmpPct: -1.66},
      issueDetail: {fetchedAt: null, endpoints: []},
      conflicts: [{field: 'issue_price', provider: 302, secondary: 305}],
    },
  }]});
  const client = new QueryClient({defaultOptions: {queries: {retry: false}}});
  render(<QueryClientProvider client={client}><NewListingsTab datasetRevision={'c'.repeat(64)} selectedAsOfDate="2026-10-06" /></QueryClientProvider>);
  const company = await screen.findByRole('button', {name: 'IPO details for Runwal Enterprises'});
  fireEvent.mouseEnter(company);
  expect(await screen.findByRole('dialog', {name: 'Runwal Enterprises IPO details'})).toBeInTheDocument();
  expect(screen.getByText('₹302')).toBeInTheDocument();
  expect(screen.getByText('₹298.95')).toBeInTheDocument();
  expect(screen.getByText(/issue price differs: primary 302; secondary 305/i)).toBeInTheDocument();
  fireEvent.click(company);
  fireEvent.mouseLeave(company);
  const card = screen.getByRole('dialog', {name: 'Runwal Enterprises IPO details'});
  expect(card).toBeInTheDocument();
  expect(screen.queryByRole('tab', {name: 'Details'})).not.toBeInTheDocument();
  fireEvent.keyDown(card, {key: 'Escape'});
  expect(screen.queryByRole('dialog', {name: 'Runwal Enterprises IPO details'})).not.toBeInTheDocument();
});

it.each(['tap', 'Tab', 'ArrowDown'])('opens IPO details on phone %s and remains open during table scroll', async input => {
  vi.mocked(screenerApi.getIpoCatalogue).mockResolvedValueOnce({records: [{
    symbol: 'RUNWALENTR', name: 'Runwal Enterprises', listingDate: '2026-10-05',
    currentPrice: 262.55, turnoverCrore: 11.2, deliveryPct: 40.54,
    sector: 'Unclassified', industry: 'Unclassified', marketCapCrore: 3880,
    issuePrice: 302,
  }]});
  const media = {matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn()};
  vi.stubGlobal('matchMedia', () => media);
  try {
    const client = new QueryClient({defaultOptions: {queries: {retry: false}}});
    render(<QueryClientProvider client={client}><NewListingsTab datasetRevision={'c'.repeat(64)} selectedAsOfDate="2026-10-06" /></QueryClientProvider>);
    const trigger = await screen.findByRole('button', {name: 'IPO details for Runwal Enterprises'});
    if (input === 'tap') fireEvent.click(trigger);
    else fireEvent.keyDown(trigger, {key: input});
    expect(await screen.findByRole('dialog', {name: 'Runwal Enterprises IPO details'})).toBeInTheDocument();
    if (input !== 'tap') expect(screen.getByRole('dialog').querySelector('button')).toHaveFocus();
    fireEvent.scroll(screen.getByLabelText('IPO table, scroll for more columns'));
    expect(screen.getByRole('dialog', {name: 'Runwal Enterprises IPO details'})).toBeInTheDocument();
  } finally {
    cleanup();
    vi.unstubAllGlobals();
  }
});
