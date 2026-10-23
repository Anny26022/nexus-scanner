import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { comparisonPeriod, fundamentalsConfig, growth, priceBandGuides, priceBandLabel, visibleFinancials, type FinancialHistory } from '../chart/fundamentals';
import { FundamentalsIndicator, FundamentalsSettingsDialog } from '../components/FundamentalsIndicator';
import { screenerApi } from '../api/screenerApi';
import { IndicatorsCatalogModal } from '../components/IndicatorsCatalogModal';
import { defaultStudies } from '../chart/studies';
import { defaultEmaLines } from '../chart/model';
vi.mock('../api/screenerApi', () => ({screenerApi: {getFinancialHistory: vi.fn(), getEarningsSchedule: vi.fn()}}));
const history: FinancialHistory = {source: 'ScanX', report_type: 'CONSOLIDATED', amount_unit: 'INR_CRORE', observed_on: '2026-10-11', annual: [], quarterly: [
  {period_end: '2025-06-30', eps: -2, net_profit: -20, sales: 100, opm: 10},
  {period_end: '2026-03-31', eps: 1, net_profit: 10, sales: 120, opm: 12},
  {period_end: '2026-06-30', eps: 2, net_profit: 20, sales: 150, opm: 15},
  {period_end: '2026-09-30', filing_date: '2026-10-24', eps: 99, sales: 9999},
]};
afterEach(() => {cleanup(); vi.resetAllMocks(); localStorage.clear();});
it('never backdates restated financials or displays future filings', () => {
  expect(visibleFinancials(history, 'quarterly', '2026-10-10')).toEqual([]);
  expect(visibleFinancials(history, 'quarterly', '2026-10-22').map(row => row.period_end)).toEqual(['2026-06-30','2026-03-31','2025-06-30']);
  expect(visibleFinancials({...history, observed_on: ''}, 'quarterly', '2026-10-22')).toEqual([]);
  expect(visibleFinancials({...history, amount_unit: 'INR_LAKH'}, 'quarterly', '2026-10-22')).toEqual([]);
});
it('matches prior periods with gaps and handles losses and zero bases', () => {
  const rows = visibleFinancials(history, 'quarterly', '2026-10-22');
  expect(comparisonPeriod(rows, rows[0], 12)?.eps).toBe(-2);
  expect(comparisonPeriod(rows, rows[1], 3)).toBeUndefined();
  expect(growth(2, -2)).toBe(200);
  expect(growth(0, 2)).toBe(-100);
  expect(growth(10, 0)).toBeNull();
  expect(growth(10, undefined)).toBeNull();
});
it('only estimates fixed numeric bands and normalizes imported settings', () => {
  expect(priceBandGuides('5%', 100)).toEqual([105, 95]);
  expect(priceBandLabel('20')).toBe('20%');
  for (const band of ['No band','', 'Unknown','30%']) expect(priceBandGuides(band, 100)).toEqual([]);
  expect(priceBandGuides('10%', 100, true)).toEqual([]);
  expect(priceBandGuides('5%', NaN)).toEqual([]);
  expect(fundamentalsConfig({enabled:true,count:99,fontSize:-5})).toMatchObject({count:13,fontSize:10,layout:'compact'});
});
const renderOverlay = (cutoff = '2026-10-22') => {
  vi.mocked(screenerApi.getFinancialHistory).mockResolvedValue(history);
  vi.mocked(screenerApi.getEarningsSchedule).mockResolvedValue({observedOn:'2026-10-22', events:[{symbol:'TEST',scheduled_date:'2026-10-25'}]});
  return render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><FundamentalsIndicator
    symbol="TEST" revision={'a'.repeat(64)} cutoff={cutoff} sessionDate="2026-10-22" metrics={{marketCapCrore:1000,circuitLimit:'5%',surveillanceAvailable:true,surveillanceAsOfDate:'2026-10-22',isAsm:true,asmStage:'I'}}
    config={{enabled:true}} onSettings={vi.fn()} onRemove={vi.fn()}/></QueryClientProvider>);
};
it('renders real growth, dated band and schedule; collapse preserves controls', async () => {
  renderOverlay();
  expect(await screen.findByRole('table')).toBeInTheDocument();
  expect(screen.getByText('5%')).toBeInTheDocument();
  expect(screen.getByText('ASM I')).toBeInTheDocument();
  expect(await screen.findByText(/Results 2026-10-25/)).toBeInTheDocument();
  const row = screen.getByRole('rowheader', {name:'Jun 26'}).closest('tr')!;
  expect(within(row).getByText('200')).toBeInTheDocument();
  expect(within(row).getByText('50')).toBeInTheDocument();
  expect(screen.queryByText('9,999')).not.toBeInTheDocument();
  fireEvent.click(screen.getByLabelText('Collapse earnings table'));
  expect(screen.queryByRole('table')).not.toBeInTheDocument();
  expect(screen.getByLabelText('Earnings and price bands settings')).toBeInTheDocument();
});
it('replay hides current bands, surveillance, schedule and unobserved statements', async () => {
  renderOverlay('2026-10-10');
  expect(await screen.findByText('No financial results observed by 2026-10-10.')).toBeInTheDocument();
  expect(screen.getByText('Unavailable')).toBeInTheDocument();
  expect(screen.queryByText('5%')).not.toBeInTheDocument();
  expect(screen.queryByText('ASM I')).not.toBeInTheDocument();
  expect(screen.queryByText(/Results 2026-10-25/)).not.toBeInTheDocument();
});
it('lets users select results layout and annual periods', () => {
  const apply = vi.fn();
  render(<FundamentalsSettingsDialog config={{enabled:true}} onApply={apply} onClose={vi.fn()}/>);
  fireEvent.change(screen.getByLabelText('Layout'), {target:{value:'results'}});
  fireEvent.change(screen.getByLabelText('Period'), {target:{value:'annual'}});
  fireEvent.click(screen.getByRole('button', {name:'Apply'}));
  expect(apply).toHaveBeenCalledWith(expect.objectContaining({enabled:true,layout:'results',period:'annual'}));
});
it('adds the native indicator through the Fundamentals catalogue category', () => {
  const apply = vi.fn();
  render(<IndicatorsCatalogModal studies={defaultStudies()} emaLines={defaultEmaLines()} interval="D" onApplyStudies={vi.fn()} onApplyEmaLines={vi.fn()} onOpenIndicatorSettings={vi.fn()} onClose={vi.fn()} onApplyFundamentals={apply}/>);
  fireEvent.click(screen.getByRole('tab', {name:'Fundamentals'}));
  fireEvent.click(screen.getByLabelText('Earnings & Price Bands'));
  expect(apply).toHaveBeenCalledWith({enabled:true});
});
