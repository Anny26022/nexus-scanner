import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { ScreenerModal } from '../components/ScreenerModal';
import { screenSnapshot, supportsSnapshotCondition, type Snapshot } from '../api/snapshotScreen';

afterEach(cleanup);
const manifest = JSON.parse(readFileSync('public/data/current.json', 'utf8'));
const snapshot: Snapshot = JSON.parse(readFileSync(`public${manifest.datasetUrl}`, 'utf8'));
const rules = ['ABOVE_EMA_10', 'ABOVE_EMA_50', 'ABOVE_EMA_200'];
const run = (metrics: Record<string, number | null>, isNegated = false, selected = rules) => screenSnapshot({
  ...snapshot, stocks:[{...snapshot.stocks[0],close:100,asOfDate:snapshot.asOfDate,historyAligned:true,metrics}],
}, {universe:'mainboard',asOfDate:snapshot.asOfDate,page:1,pageSize:15,
  expressionTree:{type:'condition',condition:{instanceId:'ma',conditionId:'PRICE_VS_MAS',parameters:{rules:selected},isNegated}}})!;

it('supports a 30-session average daily turnover comparison', () => {
  const stock = {...snapshot.stocks[0],close:100,asOfDate:snapshot.asOfDate,historyAligned:true,
    metrics:{...snapshot.stocks[0].metrics,turnover30:5}};
  const request = {universe:'mainboard' as const,asOfDate:snapshot.asOfDate,page:1,pageSize:15,
    expressionTree:{type:'condition' as const,condition:{instanceId:'turnover',conditionId:'AVG_TURNOVER',
      parameters:{comparison:'ABOVE',windowMinutes:'',lookbackDays:30,valueCr:5}}}};
  expect(screenSnapshot({...snapshot,stocks:[stock]},request)!.matchCount).toBe(1);
});

it('requires every selected average, without imposing a stack or persistence', () => {
  expect(run({ema10:80,ema50:90,ema200:70}).matchCount).toBe(1);
  expect(run({ema10:80,ema50:110,ema200:70}).matchCount).toBe(0);
  expect(run({ema10:100,ema50:90,ema200:70}).matchCount).toBe(0);
  expect(run({ema10:80,sma200:110},false,['ABOVE_EMA_10','BELOW_SMA_200']).matchCount).toBe(1);
});

it('preserves unknown values under negation and rejects empty or stale selections', () => {
  expect(run({ema10:80,ema50:90,ema200:null},true).matchCount).toBe(0);
  expect(run({ema10:80,ema50:90,ema200:null}).perConditionCoverage.ma.evaluated).toBe(0);
  for (const selected of [[],['ABOVE_EMA_999'],['ABOVE_EMA_10','ABOVE_EMA_10']]) {
    expect(supportsSnapshotCondition({instanceId:'ma',conditionId:'PRICE_VS_MAS',parameters:{rules:selected}})).toBe(false);
  }
});

it('selects several EMA comparisons in one control and saves them together', () => {
  const apply = vi.fn();
  render(<ScreenerModal isOpen onClose={vi.fn()} activeConditionsMap={{}} matchMode="all" onApply={apply} />);
  fireEvent.click(screen.getByRole('button', {name:'Moving average comparisons: Select options'}));
  const menu = screen.getByRole('group', {name:'Moving average comparisons'});
  fireEvent.click(within(menu).getByRole('checkbox', {name:'Above 10 EMA'}));
  fireEvent.click(within(menu).getByRole('checkbox', {name:'Above 50 EMA'}));
  fireEvent.click(within(menu).getByRole('checkbox', {name:'Above 200 EMA'}));
  fireEvent.click(screen.getByRole('button', {name:'Apply'}));
  expect(apply.mock.calls[0][0].PRICE_VS_MAS.parameters.rules).toEqual(rules);
});

it('removes the filter when its last comparison is removed', () => {
  const apply = vi.fn();
  render(<ScreenerModal isOpen onClose={vi.fn()} activeConditionsMap={{PRICE_VS_MAS:{instanceId:'ma',conditionId:'PRICE_VS_MAS',parameters:{rules:['ABOVE_EMA_10']}}}}
    matchMode="all" onApply={apply} />);
  fireEvent.click(screen.getByRole('button', {name:'Remove Above 10 EMA'}));
  expect(screen.queryByRole('button', {name:'Remove Above 10 EMA'})).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', {name:'Apply'}));
  expect(apply.mock.calls[0][0]).toEqual({});
});

it('clears a previously saved empty comparison filter on apply', () => {
  const apply = vi.fn();
  render(<ScreenerModal isOpen onClose={vi.fn()} activeConditionsMap={{ma:{instanceId:'ma',conditionId:'PRICE_VS_MAS',parameters:{rules:[]}}}}
    matchMode="all" onApply={apply} />);
  fireEvent.click(screen.getByRole('button', {name:'Apply'}));
  expect(apply.mock.calls[0][0]).toEqual({});
});

it('shows the selected universe when no conditions remain in either match mode', () => {
  const data = {...snapshot, stocks:[
    {...snapshot.stocks[0],symbol:'IN',close:100,indexMemberships:['NIFTY 50']},
    {...snapshot.stocks[0],symbol:'OUT',close:100,indexMemberships:[]},
  ]};
  for (const operator of ['all','any'] as const) {
    const request = {universe:'nifty50' as const,asOfDate:snapshot.asOfDate,page:1,pageSize:15,
      expressionTree:{type:'group' as const,operator,children:[]}};
    expect(screenSnapshot(data,request)!.matchedSymbols).toEqual(['IN']);
    expect(screenSnapshot(data,{...request,universe:'mainboard'})!.matchCount).toBe(2);
  }
});
