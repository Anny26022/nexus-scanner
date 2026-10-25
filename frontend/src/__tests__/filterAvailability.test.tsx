import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { ScreenerModal } from '../components/ScreenerModal';
import { hasUnavailableConditions } from '../components/UnavailableConditions';
import { NEXUS_CONDITION_CATALOG } from '../data/conditionCatalog';
import { PRESET_CATALOG } from '../data/presetCatalog';
import { isAvailableCondition, isAvailableFilter } from '../utils/filterAvailability';

afterEach(cleanup);

it('keeps published filters and presets available but disables backend-only defaults', () => {
  expect(NEXUS_CONDITION_CATALOG.filter(def => !def.id.startsWith('ETF_')).filter(isAvailableFilter)).toHaveLength(75);
  for (const conditionId of ['EARNINGS_GROWTH','fund_earnings_growth','rs_1month','rs_3month']) {
    expect(isAvailableFilter(NEXUS_CONDITION_CATALOG.find(def=>def.id===conditionId)!)).toBe(false);
  }
  expect(PRESET_CATALOG).toHaveLength(51);
  expect(PRESET_CATALOG.every(isAvailableFilter)).toBe(true);
  expect(isAvailableCondition({instanceId:'ma', conditionId:'MA_STACK', parameters:{periods:'50,173,200',maType:'EMA',priceAbove:false}})).toBe(false);
  expect(hasUnavailableConditions({unknown:{instanceId:'unknown',conditionId:'UNKNOWN',parameters:{}}})).toBe(true);
  expect(hasUnavailableConditions({stale:{instanceId:'stale',conditionId:'lib-removed-preset',parameters:{}}})).toBe(true);
});

it('disables backend rows, hides their parameters and leaves supported filters selectable', () => {
  const apply = vi.fn();
  render(<ScreenerModal isOpen onClose={vi.fn()} activeConditionsMap={{}} matchMode="all" onApply={apply} />);
  const backend = screen.getByRole('checkbox', {name:'Unfilled Gap:'});
  expect(backend).toBeDisabled();
  expect(within(backend.closest('.filter-row') as HTMLElement).queryByText('Requires backend · temporarily disabled')).not.toBeInTheDocument();
  expect(within(backend.closest('.filter-row') as HTMLElement).queryByRole('textbox')).not.toBeInTheDocument();
  const supported = screen.getByRole('checkbox', {name:'Relative Volume (RVOL):'});
  expect(supported).toBeEnabled();
  fireEvent.click(supported);
  fireEvent.click(screen.getByRole('button', {name:'Apply'}));
  expect(Object.keys(apply.mock.calls[0][0])).toEqual(['mom_rvol']);
});

it('blocks backend-only parameter settings and allows correction without losing the filter', () => {
  const apply = vi.fn();
  render(<ScreenerModal isOpen onClose={vi.fn()} activeConditionsMap={{}} matchMode="all" onApply={apply} />);
  const row = screen.getByRole('checkbox', {name:'Price vs Moving Average:'}).closest('.filter-row') as HTMLElement;
  expect(within(row).getByRole('option', {name:'EMA'})).toBeEnabled();
  const period = within(screen.getByRole('checkbox', {name:'RVOL (Volume vs Average):'}).closest('.filter-row') as HTMLElement)
    .getByRole('spinbutton', {name:'Avg days'});
  fireEvent.change(period, {target:{value:'50'}});
  expect(period.closest('.filter-row')).toHaveAttribute('data-unavailable', 'true');
  expect(period).toBeEnabled();
  expect(screen.getByRole('button', {name:'Apply'})).toBeDisabled();
  expect(screen.getByRole('alert')).toHaveTextContent('Unavailable in snapshot:');
  fireEvent.change(period, {target:{value:'20'}});
  expect(period.closest('.filter-row')).toHaveAttribute('data-unavailable', 'false');
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', {name:'Apply'}));
  expect(apply.mock.calls[0][0].VOLUME_VS_AVG.parameters.avgDays).toBe(20);
});

it('offers a supported SMA period and keeps stale SMA settings editable for recovery', () => {
  const apply = vi.fn();
  const view = render(<ScreenerModal isOpen onClose={vi.fn()} activeConditionsMap={{}} matchMode="all" onApply={apply} />);
  const checkbox = screen.getByRole('checkbox', {name: 'Price vs SMA:'});
  const row = checkbox.closest('.filter-row') as HTMLElement;
  expect(checkbox).toBeEnabled();
  expect(within(row).getByRole('spinbutton', {name: 'SMA period'})).toHaveValue(150);
  fireEvent.click(checkbox);
  fireEvent.click(screen.getByRole('button', {name: 'Apply'}));
  expect(apply.mock.calls[0][0].PRICE_VS_SMA.parameters.period).toBe(150);
  view.unmount();
  render(<ScreenerModal isOpen onClose={vi.fn()} activeConditionsMap={{PRICE_VS_SMA: {
    instanceId: 'saved', conditionId: 'PRICE_VS_SMA', parameters: {period: 173, persistDays: 1, comparison: 'ABOVE'},
  }}} matchMode="all" onApply={apply} />);
  const savedRow = screen.getByRole('checkbox', {name: 'Price vs SMA:'}).closest('.filter-row') as HTMLElement;
  expect(savedRow).toHaveAttribute('data-unavailable', 'true');
  const period = within(savedRow).getByRole('spinbutton', {name: 'SMA period'});
  expect(period).toHaveValue(173);
  expect(screen.getByRole('button', {name: 'Apply'})).toBeDisabled();
  fireEvent.change(period, {target: {value: '200'}});
  expect(savedRow).toHaveAttribute('data-unavailable', 'false');
  expect(screen.getByRole('button', {name: 'Apply'})).toBeEnabled();
});

it('keeps pre-built scans enabled in the same dialog', () => {
  const apply = vi.fn();
  render(<ScreenerModal isOpen onClose={vi.fn()} activeConditionsMap={{}} matchMode="all" onApply={apply} />);
  fireEvent.click(screen.getByRole('button', {name:'Scan Library'}));
  for (const preset of PRESET_CATALOG) expect(screen.getAllByRole('checkbox', {name:preset.label})[0]).toBeEnabled();
  // Popular scans repeat in their category; either card toggles the same scan.
  const [popular, listed] = screen.getAllByRole('checkbox', {name:'Top 1M Gainers'});
  fireEvent.click(popular);
  expect(listed).toHaveAttribute('aria-checked', 'true');
  fireEvent.click(screen.getByRole('button', {name:'Apply'}));
  expect(Object.values(apply.mock.calls[0][0])).toHaveLength(1);
});

it('offers only supported ADR/ATR/gap windows and a clearly named overall RS horizon', () => {
  const apply = vi.fn();
  render(<ScreenerModal isOpen onClose={vi.fn()} activeConditionsMap={{}} matchMode="all" onApply={apply}
    choices={{SECTOR:['Healthcare'],INDUSTRY:[],SERIES:['EQ'],PRICE_BAND:['20'],INDEX_MEMBERSHIP:['NIFTY 500']}} />);
  const row = (name: string) => screen.getByRole('checkbox', {name}).closest('.filter-row') as HTMLElement;
  expect(within(row('ADR %:')).getByRole('combobox', {name:'Lookback days'})).toHaveValue('20');
  expect(within(row('ATR %:')).getByRole('combobox', {name:'Period'})).toHaveValue('14');
  expect(within(row('Gap Up:')).getByRole('combobox', {name:'Fired within'})).toHaveValue('1');
  const rs = row('RS Rating (percentile):');
  expect(within(rs).getByRole('combobox', {name:'Horizon'})).toHaveValue('FRONT_WEIGHTED');
  expect(within(rs).getByRole('option', {name:'12 month'})).toBeDisabled();
  expect(within(row('MA Stack:')).getByRole('button', {name:'Periods: 3 selected'})).toBeEnabled();
  expect(within(row('Fundamental Metric:')).getByRole('option', {name:'P/B ratio'})).toBeEnabled();
  fireEvent.click(screen.getByRole('checkbox', {name:'Sector:'}));
  expect(screen.getByRole('button', {name:'Apply'})).toBeDisabled();
  fireEvent.click(within(row('Sector:')).getByRole('button', {name:'Sectors: Select options'}));
  fireEvent.click(within(screen.getByRole('group', {name:'Sectors'})).getByRole('checkbox', {name:'Healthcare'}));
  fireEvent.click(screen.getByRole('button', {name:'Apply'}));
  expect(apply.mock.calls[0][0].SECTOR.parameters.values).toEqual(['HEALTHCARE']);
});

it('describes each scan, searches the library and shows today\'s matches', () => {
  render(<ScreenerModal isOpen onClose={vi.fn()} activeConditionsMap={{}} matchMode="all" onApply={vi.fn()}
    choices={{SECTOR:[],INDUSTRY:[],SERIES:[],PRICE_BAND:[],INDEX_MEMBERSHIP:[],SCAN_COUNTS:{'lib-persistent-momentum':312,'lib-vcp':0},
      TRADINGVIEW_METRIC:['market.performance_1m_pct','market.performance_3m_pct']}} />);
  fireEvent.click(screen.getByRole('button', {name:'Scan Library'}));
  const card = screen.getByRole('checkbox', {name:'Persistent Momentum'});
  expect(card).toHaveAttribute('title', expect.stringContaining('Above the 10 EMA for 20 days'));
  expect(within(card).getByText('312 today')).toBeInTheDocument();
  expect(within(screen.getAllByRole('checkbox', {name:'VCP Contraction'})[0]).getByText('None today')).toBeInTheDocument();
  // This snapshot carries no TradingView 6M value yet, so that scan waits for the next refresh.
  expect(screen.getAllByRole('checkbox', {name:'Top 6M Gainers'})[0]).toBeDisabled();
  expect(screen.getAllByText('After the next data refresh').length).toBeGreaterThan(0);
  fireEvent.change(screen.getByRole('textbox', {name:'Search scans'}), {target:{value:'gainers'}});
  expect(screen.getAllByRole('checkbox').map(item => item.getAttribute('aria-label'))).toEqual(
    ['Top 1M Gainers','Top 3M Gainers','Top 6M Gainers','Top 1Y Gainers']);
});

it('saves a filter and a whole screen to My scans and brings them back', () => {
  window.localStorage.clear();
  const apply = vi.fn();
  render(<ScreenerModal isOpen onClose={vi.fn()} activeConditionsMap={{}} matchMode="all" onApply={apply} />);
  fireEvent.click(screen.getByRole('checkbox', {name:'Relative Volume (RVOL):'}));
  fireEvent.click(screen.getByRole('button', {name:'Save Relative Volume (RVOL) filter'}));
  fireEvent.change(screen.getByRole('textbox', {name:'Scan name'}), {target:{value:'Big volume'}});
  fireEvent.click(screen.getByRole('button', {name:'Save'}));
  expect(screen.getByRole('status')).toHaveTextContent('Saved “Big volume” to My scans');
  fireEvent.click(screen.getByRole('button', {name:'Scan Library'}));
  fireEvent.click(screen.getAllByRole('checkbox', {name:'Near 52-Week High'})[0]);
  fireEvent.click(screen.getByRole('button', {name:'Save as scan'}));
  fireEvent.change(screen.getByRole('textbox', {name:'Scan name'}), {target:{value:'Volume near highs'}});
  fireEvent.click(screen.getByRole('button', {name:'Save'}));
  fireEvent.click(screen.getByRole('button', {name:'Reset'}));
  fireEvent.click(screen.getByRole('button', {name:'Load Volume near highs'}));
  fireEvent.click(screen.getByRole('button', {name:'Add Big volume'}));
  fireEvent.click(screen.getByRole('button', {name:'Apply'}));
  expect(Object.values(apply.mock.calls[0][0]).map(condition => (condition as {conditionId:string}).conditionId).sort())
    .toEqual(['mom_rvol', 'mom_rvol', 'scan-near-52w-high']);
  fireEvent.click(screen.getByRole('button', {name:'Delete Big volume'}));
  expect(screen.queryByRole('button', {name:'Add Big volume'})).not.toBeInTheDocument();
});
