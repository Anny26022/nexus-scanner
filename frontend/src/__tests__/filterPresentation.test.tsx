import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { ScreenerModal } from '../components/ScreenerModal';
import { comparisonLabel, filterLogicHint, parameterPresentation } from '../utils/filterPresentation';
import { NEXUS_CONDITION_CATALOG } from '../data/conditionCatalog';
import technicalConfigurations from '../data/snapshotTechnicals.json';

afterEach(cleanup);

it('distinguishes strict price comparisons from inclusive numeric thresholds', () => {
  expect(comparisonLabel('PRICE_VS_EMA', 'ABOVE', 'Above')).toBe('> Above');
  expect(comparisonLabel('PRICE_VS_SMA', 'BELOW', 'Below')).toBe('< Below');
  expect(comparisonLabel('ADX', 'ABOVE', 'Above')).toBe('≥ At least');
  expect(comparisonLabel('PE_RATIO', 'BELOW', 'Below')).toBe('≤ At most');
  expect(comparisonLabel('ABSOLUTE_EPS', 'EQUAL', 'Equal')).toBe('= Equal to');
  expect(comparisonLabel('PRICE_CHANGE_PCT', 'BELOW', 'Below')).toBe('≤ − Decline at least');
  expect(comparisonLabel('trend_price_vs_ma', 'within_pct', 'Within % Range')).toBe('Within % Range');
});

it('hides fixed momentum controls and preserves their values on apply', () => {
  const apply = vi.fn();
  render(<ScreenerModal isOpen onClose={vi.fn()} activeConditionsMap={{}} matchMode="all" onApply={apply} />);
  const row = screen.getByRole('checkbox', {name:'Persistent Momentum:'}).closest('.filter-row') as HTMLElement;
  expect(within(row).queryByText('OR')).not.toBeInTheDocument();
  expect(within(row).queryByText('ANY')).not.toBeInTheDocument();
  expect(within(row).queryByRole('combobox')).not.toBeInTheDocument();
  expect(within(row).getByRole('button', {name:'Show Persistent Momentum description'})).toBeInTheDocument();
  fireEvent.click(within(row).getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', {name:'OR (Any)'}));
  fireEvent.click(screen.getByRole('button', {name:'Apply'}));
  expect(apply.mock.calls[0][1]).toBe('any');
  expect(apply.mock.calls[0][0].PERSISTENT_MOMENTUM.parameters).toEqual({ema10Days:20, ema20Days:30, ema50Days:50});
});

it('hides fixed technical parameters across the shared editor without hiding thresholds', () => {
  render(<ScreenerModal isOpen onClose={vi.fn()} activeConditionsMap={{}} matchMode="all" onApply={vi.fn()} />);
  for (const config of technicalConfigurations) {
    const def = NEXUS_CONDITION_CATALOG.find(def => def.id === config.id)!;
    const row = screen.getAllByRole('checkbox', {name:`${def.label}:`}).map(checkbox => checkbox.closest('.filter-row') as HTMLElement)
      .find(row => row.dataset.conditionId === config.id)!;
    for (const parameter of def.parameters.filter(parameter => Object.hasOwn(config.fixed, parameter.id))) {
      expect(row.querySelector(`[aria-label="${parameter.label}"]`)).toBeNull();
    }
  }
  const adx = screen.getByRole('checkbox', {name:'ADX (trend strength):'}).closest('.filter-row') as HTMLElement;
  expect(within(adx).getByRole('spinbutton', {name:'ADX value'})).toBeEnabled();
  expect(within(adx).getByRole('combobox', {name:'Comparison'})).toBeEnabled();
});

it('keeps comparison option values unchanged and renders an updated MA stack chain', () => {
  const apply = vi.fn();
  render(<ScreenerModal isOpen onClose={vi.fn()} activeConditionsMap={{}} matchMode="all" onApply={apply} />);
  const row = screen.getByRole('checkbox', {name:'ADX (trend strength):'}).closest('.filter-row') as HTMLElement;
  fireEvent.change(within(row).getByRole('combobox', {name:'Comparison'}), {target:{value:'BELOW'}});
  expect(within(row).getByRole('option', {name:'≤ At most'})).toHaveValue('BELOW');
  expect(screen.getByText('Close > SMA 50 > SMA 150 > SMA 200')).toBeInTheDocument();
  const stack = screen.getByRole('checkbox', {name:'MA Stack:'}).closest('.filter-row') as HTMLElement;
  fireEvent.click(within(stack).getByRole('checkbox', {name:'Price above fastest'}));
  expect(screen.getByText('SMA 50 > SMA 150 > SMA 200')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', {name:'Apply'}));
  expect(apply.mock.calls[0][0].ADX.parameters.comparison).toBe('BELOW');
});

it('shows inclusive bounds without inventing comparisons for unrelated parameters', () => {
  const range = NEXUS_CONDITION_CATALOG.find(def => def.id === 'PRICE_RANGE')!;
  expect(parameterPresentation(range.id, range.parameters[0]).prefix).toBe('≥');
  expect(parameterPresentation(range.id, range.parameters[1]).prefix).toBe('≤');
  const price = NEXUS_CONDITION_CATALOG.find(def => def.id === 'fund_stock_price')!;
  expect(parameterPresentation(price.id, price.parameters[0]).prefix).toBe('>');
  expect(filterLogicHint(range.id, {})).toContain('inclusive (AND)');
  expect(filterLogicHint('MA_STACK', {periods:'200,50,150', maType:'EMA', priceAbove:false})).toBe('EMA 50 > EMA 150 > EMA 200');
  const period = NEXUS_CONDITION_CATALOG.find(def => def.id === 'ADX')!.parameters[0];
  expect(parameterPresentation('ADX', period).prefix).toBe('');
});

it('renders inline price and range rules while preserving their saved parameters', () => {
  const apply = vi.fn();
  render(<ScreenerModal isOpen onClose={vi.fn()} activeConditionsMap={{}} matchMode="all" onApply={apply} />);
  const row = (name: string) => screen.getByRole('checkbox', {name}).closest('.filter-row') as HTMLElement;
  const price = row('Price vs EMA:');
  expect(within(price).getByText('Close')).toBeInTheDocument();
  expect(within(price).getByText('for ≥')).toBeInTheDocument();
  expect(within(price).queryByText('Comparison')).not.toBeInTheDocument();
  fireEvent.change(within(price).getByRole('combobox', {name:'Comparison'}), {target:{value:'BELOW'}});
  const range = row('Price Range (₹):');
  expect(within(range).getByText('Between')).toBeInTheDocument();
  expect(within(range).getByText('to')).toBeInTheDocument();
  fireEvent.change(within(range).getByRole('spinbutton', {name:'Min price'}), {target:{value:'100'}});
  fireEvent.click(screen.getByRole('button', {name:'Apply'}));
  expect(apply.mock.calls[0][0].PRICE_VS_EMA.parameters).toEqual({period:20, comparison:'BELOW', persistDays:10});
  expect(apply.mock.calls[0][0].PRICE_RANGE.parameters).toEqual({minPrice:100, maxPrice:10000});
});

it('shows percentage-distance input only when that comparison uses it', () => {
  render(<ScreenerModal isOpen onClose={vi.fn()} activeConditionsMap={{}} matchMode="all" onApply={vi.fn()} />);
  const row = screen.getByRole('checkbox', {name:'Price vs Moving Average:'}).closest('.filter-row') as HTMLElement;
  expect(within(row).queryByRole('spinbutton', {name:'Threshold %'})).not.toBeInTheDocument();
  fireEvent.change(within(row).getByRole('combobox', {name:'Position'}), {target:{value:'within_pct'}});
  expect(within(row).getByRole('spinbutton', {name:'Threshold %'})).toHaveValue(0);
});
