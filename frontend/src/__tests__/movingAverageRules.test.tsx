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
  fireEvent.click(screen.getByRole('button', {name:'Moving average comparisons: 1 selected'}));
  const menu = screen.getByRole('group', {name:'Moving average comparisons'});
  fireEvent.click(within(menu).getByRole('checkbox', {name:'Above 50 EMA'}));
  fireEvent.click(within(menu).getByRole('checkbox', {name:'Above 200 EMA'}));
  fireEvent.click(screen.getByRole('button', {name:'Apply'}));
  expect(apply.mock.calls[0][0].PRICE_VS_MAS.parameters.rules).toEqual(rules);
});

it('can remove rules and blocks an active empty selection', () => {
  render(<ScreenerModal isOpen onClose={vi.fn()} activeConditionsMap={{PRICE_VS_MAS:{instanceId:'ma',conditionId:'PRICE_VS_MAS',parameters:{rules:['ABOVE_EMA_10']}}}}
    matchMode="all" onApply={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', {name:'Remove Above 10 EMA'}));
  expect(screen.getByRole('button', {name:'Apply'})).toBeDisabled();
});
