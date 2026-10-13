import {afterEach, expect, it, vi} from 'vitest';
import {cleanup, fireEvent, render, screen, within} from '@testing-library/react';
import {ScreenerModal} from '../components/ScreenerModal';
import type {FilterChoices} from '../api/snapshotEngine';

afterEach(cleanup);
const choices: FilterChoices = {SECTOR:['Healthcare','Castings, Forgings & Fastners'], INDUSTRY:['Software','Banks'],
  SERIES:['EQ','BE','BZ'], PRICE_BAND:['2','5','10','20','No Band'], INDEX_MEMBERSHIP:['NIFTY 500','Nifty 50','Nifty Bank']};
const row = (name:string) => within(screen.getByRole('checkbox', {name:`${name}:`}).closest('.filter-row') as HTMLElement);
const props = {isOpen:true,onClose:vi.fn(),matchMode:'all' as const,choices};

it('searches and selects one index while preserving the evaluator contract', () => {
  const apply = vi.fn();
  render(<ScreenerModal {...props} activeConditionsMap={{}} onApply={apply} />);
  expect(row('Index Membership').queryByRole('textbox')).toBeNull();
  fireEvent.click(row('Index Membership').getByRole('button', {name:'Index: 1 selected'}));
  fireEvent.change(screen.getByRole('textbox', {name:'Search Index'}), {target:{value:'bank'}});
  expect(screen.queryByRole('radio', {name:'NIFTY 500'})).toBeNull();
  fireEvent.click(screen.getByRole('radio', {name:'Nifty Bank'}));
  expect(screen.queryByRole('group', {name:'Index'})).toBeNull();
  fireEvent.click(screen.getByRole('button', {name:'Apply'}));
  expect(apply.mock.calls[0][0].INDEX_MEMBERSHIP.parameters.indexName).toBe('NIFTY BANK');
});

it.each([['Sector','Sectors','Castings, Forgings & Fastners','SECTOR'], ['Industry','Industries','Software','INDUSTRY'],
  ['Series (EQ / BE)','Series','BZ','SERIES'], ['Price Band','Bands','No Band','PRICE_BAND']])('selects %s without splitting comma-containing labels', (name,label,value,id) => {
  const apply = vi.fn();
  render(<ScreenerModal {...props} activeConditionsMap={{}} onApply={apply} />);
  const button = row(name).getByRole('button', {name:new RegExp(`^${label}:`)});
  fireEvent.click(button);
  fireEvent.click(within(screen.getByRole('group', {name:label})).getByRole('checkbox', {name:value}));
  fireEvent.click(screen.getByRole('button', {name:'Apply'}));
  expect(apply.mock.calls[0][0][id].parameters.values).toContain(value.toUpperCase());
});

it('retains absent saved choices and permits removing them without rewriting other rules', () => {
  const apply = vi.fn();
  const saved = {old:{instanceId:'saved',conditionId:'SECTOR',parameters:{values:'Old Sector, Healthcare'}}};
  render(<ScreenerModal {...props} activeConditionsMap={saved} onApply={apply} />);
  fireEvent.click(row('Sector').getByRole('button', {name:'Sectors: 2 selected'}));
  fireEvent.click(screen.getByRole('checkbox', {name:'OLD SECTOR'}));
  fireEvent.click(screen.getByRole('button', {name:'Apply'}));
  expect(apply.mock.calls[0][0].old).toEqual({...saved.old,parameters:{values:['HEALTHCARE']}});
});

it('selects supported MA periods while retaining type and price-above settings', () => {
  const apply = vi.fn();
  render(<ScreenerModal {...props} activeConditionsMap={{}} onApply={apply} />);
  fireEvent.click(row('MA Stack').getByRole('button', {name:'Periods: 3 selected'}));
  fireEvent.click(within(screen.getByRole('group', {name:'Periods'})).getByRole('checkbox', {name:'10'}));
  fireEvent.click(screen.getByRole('button', {name:'Apply'}));
  expect(apply.mock.calls[0][0].MA_STACK.parameters).toEqual({periods:'50, 150, 200, 10',maType:'SMA',priceAbove:true});
});

it('shows loading and retry states instead of an empty free-text picker', () => {
  const retry = vi.fn();
  render(<ScreenerModal {...props} choices={undefined} choicesError retryChoices={retry} activeConditionsMap={{}} onApply={vi.fn()} />);
  expect(row('Sector').getByRole('button', {name:'Sectors: Select options'})).toBeDisabled();
  fireEvent.click(screen.getByRole('button', {name:'Retry'}));
  expect(retry).toHaveBeenCalledOnce();
});
