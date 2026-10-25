import {afterEach, expect, it, vi} from 'vitest';
import {cleanup, fireEvent, render, screen} from '@testing-library/react';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import EarningsTab from '../components/EarningsTab';
vi.mock('../api/screenerApi', () => ({screenerApi:{
  getChartRows:vi.fn().mockResolvedValue([]),
  getThemeClassification:vi.fn().mockRejectedValue(new Error('Classification release mismatch')),
}}));
vi.mock('../api/earnings', async importOriginal => ({...await importOriginal<typeof import('../api/earnings')>(),
  getEarningsIndex:vi.fn().mockResolvedValue({version:1, quarters:{'2026-Q4':{checkedAt:'2026-10-23',
    published:{sha256:'published',url:'/published.json.gz',count:1}, upcoming:{sha256:'upcoming',url:'/upcoming.json.gz',count:0}}}}),
  getEarningsFile:vi.fn().mockResolvedValue([{symbol:'TEST',filing_day:'2026-10-23',period_end:'2026-09-30',isUpcoming:false}]),
}));
afterEach(() => {cleanup(); vi.unstubAllGlobals();});
it('shows a retryable classification error instead of a false Unclassified facet', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  const client = new QueryClient({defaultOptions:{queries:{retry:false}}});
  render(<QueryClientProvider client={client}><EarningsTab datasetRevision={'a'.repeat(64)} onOpenChart={vi.fn()}/></QueryClientProvider>);
  fireEvent.change(await screen.findByRole('combobox', {name:'Break down by'}), {target:{value:'theme'}});
  expect(await screen.findByRole('alert')).toHaveTextContent('Classifications could not load');
  expect(screen.getByRole('button', {name:'Retry'})).toBeInTheDocument();
  expect(screen.queryByRole('button', {name:/Unclassified/})).not.toBeInTheDocument();
});
