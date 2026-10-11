import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { ScreenerModal } from '../components/ScreenerModal';
import { hasUnavailableConditions } from '../components/UnavailableConditions';
import { NEXUS_CONDITION_CATALOG } from '../data/conditionCatalog';
import { PRESET_CATALOG } from '../data/presetCatalog';
import { isAvailableCondition, isAvailableFilter } from '../utils/filterAvailability';

afterEach(cleanup);

it('keeps published filters and presets available but disables backend-only defaults', () => {
  expect(NEXUS_CONDITION_CATALOG.filter(isAvailableFilter)).toHaveLength(24);
  expect(PRESET_CATALOG).toHaveLength(45);
  expect(PRESET_CATALOG.every(isAvailableFilter)).toBe(true);
  expect(isAvailableCondition({instanceId:'ma', conditionId:'MA_STACK', parameters:{periods:'50,150,200',maType:'EMA',priceAbove:false}})).toBe(false);
  expect(hasUnavailableConditions({unknown:{instanceId:'unknown',conditionId:'UNKNOWN',parameters:{}}})).toBe(true);
});

it('disables backend rows, hides their parameters and leaves supported filters selectable', () => {
  const apply = vi.fn();
  render(<ScreenerModal isOpen onClose={vi.fn()} activeConditionsMap={{}} matchMode="all" onApply={apply} />);
  const backend = screen.getByRole('checkbox', {name:'MA Stack (50 > 150 > 200):'});
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
  expect(within(row).getByRole('option', {name:'EMA'})).toBeDisabled();
  const period = within(screen.getByRole('checkbox', {name:'RVOL (Volume vs Average):'}).closest('.filter-row') as HTMLElement)
    .getByRole('spinbutton', {name:'Avg days'});
  fireEvent.change(period, {target:{value:'50'}});
  expect(screen.getByRole('button', {name:'Apply'})).toBeDisabled();
  expect(screen.getByRole('alert')).toHaveTextContent('Backend-dependent filters are temporarily disabled');
  fireEvent.change(period, {target:{value:'20'}});
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', {name:'Apply'}));
  expect(apply.mock.calls[0][0].VOLUME_VS_AVG.parameters.avgDays).toBe(20);
});

it('keeps pre-built scans enabled in the same dialog', () => {
  const apply = vi.fn();
  render(<ScreenerModal isOpen onClose={vi.fn()} activeConditionsMap={{}} matchMode="all" onApply={apply} />);
  fireEvent.click(screen.getByRole('button', {name:'Pre-built Scans'}));
  const presets = screen.getAllByRole('checkbox');
  expect(presets).toHaveLength(45);
  for (const preset of presets) expect(preset).toBeEnabled();
  fireEvent.click(presets[0]);
  fireEvent.click(screen.getByRole('button', {name:'Apply'}));
  expect(Object.values(apply.mock.calls[0][0])).toHaveLength(1);
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
