import {afterEach, expect, it, vi} from 'vitest';
import {cleanup, fireEvent, render, screen} from '@testing-library/react';
import {ScreenerModal} from '../components/ScreenerModal';
import {NEXUS_CONDITION_CATALOG} from '../data/conditionCatalog';
import {explainCondition} from '../utils/nqlParser';
import type {ActiveCondition} from '../types/screener';
import {loadPublishedSnapshot} from './fixtures/publishedSnapshot';
import {screenSnapshot, type Snapshot} from '../api/snapshotScreen';

afterEach(cleanup);

it.each(['FUNDAMENTAL_METRIC', 'mom_return'])('edits, removes and reopens independent %s rules', id => {
  const def = NEXUS_CONDITION_CATALOG.find(def => def.id === id)!;
  const defaults = Object.fromEntries(def.parameters.map(parameter => [parameter.id, parameter.defaultValue]));
  const saved: ActiveCondition = {instanceId:'saved-instance', conditionId:id, parameters:defaults};
  const apply = vi.fn();
  const props = {isOpen:true, onClose:vi.fn(), activeConditionsMap:{'legacy-map-key':saved}, matchMode:'all' as const, onApply:apply};
  const view = render(<ScreenerModal {...props} />);
  fireEvent.change(screen.getByRole('textbox', {name:'Search filters'}), {target:{value:def.label}});
  fireEvent.click(screen.getByRole('button', {name:`Add ${def.label} rule`}));
  const field = id === 'mom_return' ? 'Min Return %' : def.parameters.find(parameter => parameter.id === 'value')!.label;
  fireEvent.change(screen.getAllByRole('spinbutton', {name:field})[1], {target:{value:'17'}});
  fireEvent.click(screen.getByRole('button', {name:'OR (Any)'}));
  fireEvent.click(screen.getByRole('button', {name:'Apply'}));
  const [rules, mode] = apply.mock.calls[0];
  expect(mode).toBe('any');
  expect(Object.values(rules)).toHaveLength(2);
  expect(rules['legacy-map-key']).toEqual(saved);
  const sibling = Object.keys(rules).find(key => key !== 'legacy-map-key')!;
  expect(rules[sibling].parameters[id === 'mom_return' ? 'minReturn' : 'value']).toBe(17);
  expect(rules[sibling].instanceId).not.toBe(saved.instanceId);
  view.unmount();
  render(<ScreenerModal {...props} activeConditionsMap={rules} matchMode="any" />);
  fireEvent.change(screen.getByRole('textbox', {name:'Search filters'}), {target:{value:def.label}});
  fireEvent.click(screen.getAllByRole('checkbox', {name:`${def.label}:`})[0]);
  fireEvent.click(screen.getByRole('button', {name:'Apply'}));
  expect(apply.mock.calls[1][0]).toEqual({[sibling]:rules[sibling]});
  fireEvent.click(screen.getByRole('button', {name:'Reset'}));
  fireEvent.click(screen.getByRole('button', {name:'Apply'}));
  expect(apply.mock.calls[2][0]).toEqual({});
});

it('keeps saved ROE controls editable while consolidating new selections', () => {
  const props = {isOpen:true, onClose:vi.fn(), matchMode:'all' as const, onApply:vi.fn()};
  const view = render(<ScreenerModal {...props} activeConditionsMap={{}} />);
  expect(screen.queryByRole('checkbox', {name:'Return on Equity (ROE) %:'})).toBeNull();
  view.unmount();
  render(<ScreenerModal {...props} activeConditionsMap={{old:{instanceId:'old', conditionId:'fund_roe', parameters:{minRoe:15}}}} />);
  expect(screen.getByRole('checkbox', {name:'Return on Equity (ROE) %:'})).toBeChecked();
});

it('describes metric and period independently for repeated rule chips', () => {
  const rule = (conditionId:string, parameters:Record<string, unknown>) => explainCondition({instanceId:'x', conditionId, parameters}).explanation;
  expect(rule('FUNDAMENTAL_METRIC', {metric:'ROE', comparison:'ABOVE', value:15})).toContain('≥ 15');
  expect(rule('mom_return', {period:'21D', minReturn:-5, maxReturn:10})).toBe('21D return: -5% ≤ return ≤ 10%');
  expect(rule('PRICE_CHANGE_PCT', {overDays:5, comparison:'BELOW', pct:3})).toBe('5-session return ≤ -3%');
});

it('evaluates repeated fundamental and return rules with existing AND/OR semantics', () => {
  const published = loadPublishedSnapshot().snapshot;
  const snapshot: Snapshot = {...published, stocks:[{...published.stocks[0],
    asOfDate:published.asOfDate, metadataAsOfDate:published.asOfDate, historyAligned:true,
    roePct:20, rocePct:10, changePct:3, metrics:{return21:12}}]};
  for (const rules of [
    [{metric:'ROE', comparison:'ABOVE', value:15}, {metric:'ROCE', comparison:'ABOVE', value:15}],
    [{period:'1D', minReturn:2, maxReturn:5}, {period:'21D', minReturn:15, maxReturn:30}],
  ]) {
    for (const operator of ['all','any'] as const) {
      const result = screenSnapshot(snapshot, {universe:'mainboard', asOfDate:published.asOfDate, page:1, pageSize:15,
        expressionTree:{type:'group', operator, children:rules.map((parameters, index) => ({type:'condition', condition:{
          instanceId:`rule-${index}`, conditionId:'metric' in parameters ? 'FUNDAMENTAL_METRIC' : 'mom_return', parameters,
        }}))}})!;
      expect(result.matchCount).toBe(operator === 'all' ? 0 : 1);
      expect(Object.keys(result.perConditionCoverage)).toEqual(['rule-0','rule-1']);
    }
  }
});
