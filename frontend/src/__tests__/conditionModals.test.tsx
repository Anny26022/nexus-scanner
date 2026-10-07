import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ConditionCatalogModal } from '../components/ConditionCatalogModal';
import { ScreenerModal } from '../components/ScreenerModal';
import { NEXUS_CONDITION_CATALOG } from '../data/conditionCatalog';

afterEach(cleanup);
function active(conditionId: string) {
  const definition = NEXUS_CONDITION_CATALOG.find(item => item.id === conditionId)!;
  return {[conditionId]: {instanceId:'test', conditionId,
    parameters:Object.fromEntries(definition.parameters.map(p => [p.id, p.defaultValue]))}};
}

it('lets a user edit and apply a valid convergence list in the catalog modal', () => {
  const apply = vi.fn();
  render(<ConditionCatalogModal isOpen onClose={vi.fn()} matchMode="all"
    activeConditionsMap={active('MA_CONVERGENCE')} onApplyConditions={apply} />);
  fireEvent.change(screen.getByPlaceholderText(/Search indicator/), {target:{value:'MA Convergence'}});
  const periods = screen.getByRole('textbox', {name:'Periods'});
  fireEvent.change(periods, {target:{value:'9,20,50'}});
  const button = screen.getByRole('button', {name:/Apply Filters/});
  expect(button).toBeEnabled();
  fireEvent.click(button);
  expect(apply.mock.calls[0][0].MA_CONVERGENCE.parameters.periods).toBe('9,20,50');
});

it.each(['catalog', 'screener'])('blocks a cleared zero-minimum field in the %s modal and allows recovery', modal => {
  const apply = vi.fn();
  const props = {isOpen:true, onClose:vi.fn(), matchMode:'all' as const,
    activeConditionsMap:active('DIVERGENCE')};
  if (modal === 'catalog') {
    render(<ConditionCatalogModal {...props} onApplyConditions={apply} />);
    fireEvent.change(screen.getByPlaceholderText(/Search indicator/), {target:{value:'Divergence'}});
  } else {
    render(<ScreenerModal {...props} onApply={apply} />);
  }
  const input = screen.getByRole('spinbutton', {name:'Pivot gap'});
  fireEvent.change(input, {target:{value:''}});
  const button = screen.getByRole('button', {name:modal === 'catalog' ? /Apply Filters/ : 'Apply'});
  expect(button).toBeDisabled();
  fireEvent.click(button);
  expect(apply).not.toHaveBeenCalled();
  fireEvent.change(input, {target:{value:'0'}});
  expect(button).toBeEnabled();
  fireEvent.click(button);
  expect(apply.mock.calls[0][0].DIVERGENCE.parameters.maxBarDifference).toBe(0);
});


it.each([
  ['DIVERGENCE', 'invalidateOnBreak', true],
  ['DIVERGENCE', 'invalidateOnBreak', false],
] as const)('edits %s boolean parameters and submits a boolean', (conditionId, parameterId, initial) => {
  const apply = vi.fn();
  const map = active(conditionId);
  map[conditionId].parameters[parameterId] = initial;
  const definition = NEXUS_CONDITION_CATALOG.find(item => item.id === conditionId)!;
  const parameter = definition.parameters.find(item => item.id === parameterId)!;
  render(<ConditionCatalogModal isOpen onClose={vi.fn()} matchMode="all"
    activeConditionsMap={map} onApplyConditions={apply} />);
  fireEvent.change(screen.getByPlaceholderText(/Search indicator/), {target:{value:definition.label}});
  const input = screen.getByRole('checkbox', {name:parameter.label});
  expect((input as HTMLInputElement).checked).toBe(initial);
  fireEvent.click(input);
  expect((input as HTMLInputElement).checked).toBe(!initial);
  fireEvent.click(screen.getByRole('button', {name:/Apply Filters/}));
  expect(apply.mock.calls[0][0][conditionId].parameters[parameterId]).toBe(!initial);
});


it('preserves the existing F&O select parameter contract', () => {
  const apply = vi.fn();
  const definition = NEXUS_CONDITION_CATALOG.find(item => item.id === 'misc_fno_only')!;
  render(<ConditionCatalogModal isOpen onClose={vi.fn()} matchMode="all"
    activeConditionsMap={active('misc_fno_only')} onApplyConditions={apply} />);
  fireEvent.change(screen.getByPlaceholderText(/Search indicator/), {target:{value:definition.label}});
  fireEvent.change(screen.getByRole('combobox', {name:'Status'}), {target:{value:'false'}});
  fireEvent.click(screen.getByRole('button', {name:/Apply Filters/}));
  expect(apply.mock.calls[0][0].misc_fno_only.parameters.isFno).toBe('false');
});
