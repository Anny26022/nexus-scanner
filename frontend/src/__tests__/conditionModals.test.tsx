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
