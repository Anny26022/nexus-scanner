import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { ScreenerModal } from '../components/ScreenerModal';
import { hasUnavailableConditions } from '../components/UnavailableConditions';
import { NEXUS_CONDITION_CATALOG } from '../data/conditionCatalog';
import { PRESET_CATALOG } from '../data/presetCatalog';
import { isAvailableCondition, isAvailableFilter } from '../utils/filterAvailability';

afterEach(cleanup);

it('keeps published filters and presets available but disables backend-only defaults', () => {
  expect(NEXUS_CONDITION_CATALOG.filter(isAvailableFilter)).toHaveLength(75);
  for (const conditionId of ['EARNINGS_GROWTH','fund_earnings_growth','rs_1month','rs_3month']) {
    expect(isAvailableFilter(NEXUS_CONDITION_CATALOG.find(def=>def.id===conditionId)!)).toBe(false);
  }
  expect(PRESET_CATALOG).toHaveLength(61);
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
  fireEvent.click(screen.getByRole('button', {name:'Pre-built Scans'}));
  const presets = screen.getAllByRole('checkbox');
  expect(presets).toHaveLength(61);
  for (const preset of presets) expect(preset).toBeEnabled();
  fireEvent.click(presets[0]);
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

it('reveals and hides a preset explanation from its compact info button', () => {
  render(<ScreenerModal isOpen onClose={vi.fn()} activeConditionsMap={{}} matchMode="all" onApply={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', {name:'Pre-built Scans'}));
  expect(screen.queryByText(/Above the 10 EMA for 20 days/)).not.toBeInTheDocument();
  const info = screen.getByRole('button', {name:'Show Persistent Momentum description'});
  expect(info).toHaveAttribute('data-tooltip', expect.stringContaining('Above the 10 EMA for 20 days'));
  fireEvent.click(info);
  expect(screen.getByText(/Above the 10 EMA for 20 days/)).toBeInTheDocument();
  expect(info).toHaveAttribute('aria-expanded','true');
  fireEvent.click(screen.getByRole('button', {name:'Hide Persistent Momentum description'}));
  expect(screen.queryByText(/Above the 10 EMA for 20 days/)).not.toBeInTheDocument();
});
