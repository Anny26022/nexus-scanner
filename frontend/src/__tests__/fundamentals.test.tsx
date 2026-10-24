import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, waitFor, fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { bandChanges, comparisonPeriod, fundamentalsConfig, growth, priceBandGuides, priceBandLabel, upcomingResults, visibleFinancials, type FinancialHistory, type FundamentalsConfig } from '../chart/fundamentals';
import { FundamentalsIndicator, FundamentalsSettingsDialog } from '../components/FundamentalsIndicator';
import { screenerApi } from '../api/screenerApi';
import { IndicatorsCatalogModal } from '../components/IndicatorsCatalogModal';
import { defaultStudies } from '../chart/studies';
import { defaultEmaLines } from '../chart/model';
vi.mock('../api/screenerApi', () => ({screenerApi: {getFinancialHistory: vi.fn(), getEarningsSchedule: vi.fn()}}));
const history: FinancialHistory = {report_type: 'CONSOLIDATED', amount_unit: 'INR_CRORE', observed_on: '2026-10-11', annual: [], quarterly: [
  {period_end: '2025-06-30', eps: -2, net_profit: -20, sales: 100, opm: 10, profit_before_tax: -0.2},
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
  expect(fundamentalsConfig({enabled:true,count:99})).toMatchObject({count:13,layout:'compact'});
});
const renderOverlay = (cutoff = '2026-10-22', config: FundamentalsConfig = {enabled: true}, metrics: object = {}) => {
  vi.mocked(screenerApi.getFinancialHistory).mockResolvedValue(history);
  vi.mocked(screenerApi.getEarningsSchedule).mockResolvedValue({observedOn:'2026-10-22', events:[{symbol:'TEST',scheduled_date:'2026-10-25'}]});
  return render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><div><FundamentalsIndicator
    symbol="TEST" revision={'a'.repeat(64)} cutoff={cutoff} sessionDate="2026-10-22"
    metrics={{marketCapCrore:1000,freeFloatPct:40,listingDate:'01-MAR-2005',circuitLimit:'5%',sector:'Consumer Discretionary',industry:'Diamond, Gems and Jewellery',surveillanceAvailable:true,surveillanceAsOfDate:'2026-10-22',isAsm:true,asmStage:'LTASM - I (13)',...metrics}}
    config={config}/></div></QueryClientProvider>);
};
it('shows the band badge with the results countdown and ASM status, and the compact growth table', async () => {
  renderOverlay();
  const badge = screen.getByRole('group', {name: 'TEST price band'});
  expect(within(badge).getByText('5%').closest('[data-band]')).toHaveAttribute('data-band', '5');
  expect(within(badge).getByText('LTASM - I')).toBeInTheDocument();
  expect(await within(badge).findByText('3 DAYS')).toBeInTheDocument();
  expect(await screen.findByRole('table')).toBeInTheDocument();
  expect(screen.getByText('MCAP 1,000 CR | FF 400 CR | LISTED 2005')).toBeInTheDocument();
  expect(screen.getByText('Consumer Discretionary | Diamond, Gems and Jewellery')).toBeInTheDocument();
  const row = screen.getByRole('rowheader', {name:'Jun-26'}).closest('tr')!;
  // EPS 2 vs -2 a year earlier (+200%) and vs 1 a quarter earlier (+100%); sales +50% YoY, +25% QoQ.
  expect(within(row).getByText('+200%')).toHaveAttribute('data-trend', 'up');
  expect(within(row).getByText('+100%')).toBeInTheDocument();
  expect(within(row).getByText('+50%')).toBeInTheDocument();
  expect(screen.queryByText('9,999')).not.toBeInTheDocument();
});
it('colours bands like the extension and labels no-band and F&O stocks', () => {
  renderOverlay('2026-10-22', {enabled: true, table: false}, {circuitLimit: '20%', isAsm: false});
  expect(screen.getByText('20%').closest('[data-band]')).toHaveAttribute('data-band', '20');
  cleanup();
  renderOverlay('2026-10-22', {enabled: true, table: false}, {circuitLimit: 'No band', isFno: true, isAsm: false});
  expect(screen.getByText('F&O').closest('[data-band]')).toHaveAttribute('data-band', 'none');
  cleanup();
  renderOverlay('2026-10-22', {enabled: true, table: false}, {circuitLimit: 'No band', isAsm: false});
  expect(screen.getByText('NB')).toBeInTheDocument();
});
it('highlights record values in the results layout', async () => {
  renderOverlay('2026-10-22', {enabled: true, layout: 'essential', band: false});
  const row = (await screen.findByRole('rowheader', {name: 'Sales'})).closest('tr')!;
  expect(within(row).getByText('150')).toHaveAttribute('data-breakout', 'up');
  expect(screen.queryByRole('group', {name: 'TEST price band'})).not.toBeInTheDocument();
  expect(screen.queryByText('-0')).not.toBeInTheDocument();
});
it('replay hides current bands, surveillance, schedule and unobserved statements', async () => {
  renderOverlay('2026-10-10');
  // Nothing published by then, so no empty results card covers the chart.
  await waitFor(() => expect(screen.queryByRole('region', {name: 'TEST results'})).not.toBeInTheDocument());
  expect(screen.queryByRole('group', {name: 'TEST price band'})).not.toBeInTheDocument();
  expect(screen.queryByText('LTASM - I')).not.toBeInTheDocument();
});
it('lets users choose what to show and the results layout', () => {
  const apply = vi.fn();
  render(<FundamentalsSettingsDialog config={{enabled:true}} onApply={apply} onClose={vi.fn()}/>);
  fireEvent.click(screen.getByLabelText('Results countdown in the badge'));
  fireEvent.click(screen.getByLabelText('Upper and lower circuit lines (UC / LC)'));
  fireEvent.change(screen.getByLabelText('Layout'), {target:{value:'results'}});
  fireEvent.change(screen.getByLabelText('Period'), {target:{value:'annual'}});
  fireEvent.click(screen.getByRole('button', {name:'Apply'}));
  expect(apply).toHaveBeenCalledWith(expect.objectContaining({enabled:true,resultDate:false,guides:false,layout:'results',period:'annual'}));
});
it('adds the indicator through the Fundamentals catalogue category', () => {
  const apply = vi.fn();
  render(<IndicatorsCatalogModal studies={defaultStudies()} emaLines={defaultEmaLines()} interval="D" onApplyStudies={vi.fn()} onApplyEmaLines={vi.fn()} onOpenIndicatorSettings={vi.fn()} onClose={vi.fn()} onApplyFundamentals={apply}/>);
  fireEvent.click(screen.getByRole('tab', {name:'Fundamentals'}));
  fireEvent.click(screen.getByLabelText('Price Band & Results'));
  expect(apply).toHaveBeenCalledWith({enabled:true});
});
it('migrates older saved settings', () => {
  expect(fundamentalsConfig({enabled: true, fontSize: 13.2, offset: {x: 2, y: -1}} as never)).toMatchObject({tableScale: 1.2, offset: {x: 1, y: 0}, badgeOffset: null, guides: true, count: 5});
});
it('moves the badge and the table separately with the keyboard, clamped inside the chart', async () => {
  const onMove = vi.fn(), onMoveBadge = vi.fn();
  vi.mocked(screenerApi.getFinancialHistory).mockResolvedValue(history);
  vi.mocked(screenerApi.getEarningsSchedule).mockResolvedValue(null);
  render(<QueryClientProvider client={new QueryClient()}><div><FundamentalsIndicator symbol="TEST" revision={'a'.repeat(64)} cutoff="2026-10-22" sessionDate="2026-10-22"
    metrics={{marketCapCrore: 1, circuitLimit: '10%'}} config={{enabled:true}} onMove={onMove} onMoveBadge={onMoveBadge}/></div></QueryClientProvider>);
  const panel = await screen.findByRole('region', {name:'TEST results'});
  panel.getBoundingClientRect = () => ({left:100,top:50,width:300,height:200} as DOMRect);
  panel.parentElement!.getBoundingClientRect = () => ({left:0,top:0,width:800,height:600} as DOMRect);
  fireEvent.keyDown(panel, {key:'ArrowRight'});
  expect(onMove).toHaveBeenLastCalledWith({x:110/500,y:50/400});
  panel.getBoundingClientRect = () => ({left:0,top:0,width:300,height:200} as DOMRect);
  fireEvent.keyDown(panel, {key:'ArrowLeft'});
  expect(onMove).toHaveBeenLastCalledWith({x:0,y:0});
  const badge = screen.getByRole('group', {name: 'TEST price band'});
  badge.getBoundingClientRect = () => ({left:700,top:10,width:60,height:24} as DOMRect);
  fireEvent.keyDown(badge, {key:'ArrowDown'});
  expect(onMoveBadge).toHaveBeenLastCalledWith({x:700/740,y:20/576});
  expect(onMove).toHaveBeenCalledTimes(2);
});
it('finds the next results date within 90 days once the calendar is observed', () => {
  const schedule = {observedOn: '2026-10-20', events: [{scheduled_date: '2027-03-01'}, {scheduled_date: '2026-11-03'}, {scheduled_date: '2026-10-01'}]};
  expect(upcomingResults(schedule, '2026-10-22')?.scheduled_date).toBe('2026-11-03');
  expect(upcomingResults({...schedule, events: [{scheduled_date: '2027-03-01'}]}, '2026-10-22')).toBeNull();
  expect(upcomingResults({...schedule, observedOn: '2026-10-25'}, '2026-10-22')).toBeNull();
  expect(fundamentalsConfig({enabled: true})).toMatchObject({earningsLabel: true, earningsLine: false});
});
it('turns dated bands into changes up to the cutoff', () => {
  const bands = [['2021-10-01', '20'], ['2023-01-19', '5'], ['2023-10-19', '10'], ['2026-11-01', '20']] as const;
  expect(bandChanges(bands, '2026-10-22')).toEqual([{date: '2023-01-19', from: '20', to: '5'}, {date: '2023-10-19', from: '5', to: '10'}]);
  expect(bandChanges([['2021-10-01', '20']], '2026-10-22')).toEqual([]);
  expect(bandChanges(undefined, '2026-10-22')).toEqual([]);
  expect(fundamentalsConfig({enabled: true}).bandHistory).toBe(true);
});

it('leaves the results body scrollable and captures only handle drags', async () => {
  renderOverlay();
  await screen.findByRole('table');
  const panel=screen.getByRole('region',{name:'TEST results'});
  panel.setPointerCapture=vi.fn();
  const bodyEvent=new MouseEvent('pointerdown',{bubbles:true,cancelable:true,button:0});
  fireEvent(panel.querySelector('table')!,bodyEvent);
  expect(bodyEvent.defaultPrevented).toBe(false);
  expect(panel.setPointerCapture).not.toHaveBeenCalled();
  const handleEvent=new MouseEvent('pointerdown',{bubbles:true,cancelable:true,button:0});
  fireEvent(panel.querySelector('.pb-drag-handle')!,handleEvent);
  expect(handleEvent.defaultPrevented).toBe(true);
  expect(panel.setPointerCapture).toHaveBeenCalledOnce();
  fireEvent.pointerCancel(panel);
});
