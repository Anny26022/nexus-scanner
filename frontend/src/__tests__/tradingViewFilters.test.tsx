import {afterEach, expect, it, vi} from 'vitest';
import {cleanup, fireEvent, render, screen, within} from '@testing-library/react';
import {readFileSync} from 'node:fs';
import {screenSnapshot, supportsSnapshotCondition, type Snapshot} from '../api/snapshotScreen';
import {createSnapshotEngine} from '../api/snapshotEngine';
import {tradingViewMetrics, tradingViewFilterGroups} from '../data/tradingViewMetrics';
import {ScreenerModal} from '../components/ScreenerModal';
import {ResultsTable} from '../components/ResultsTable';
import type {ScreenerRunRequest} from '../types/screener';

afterEach(cleanup);
const manifest = JSON.parse(readFileSync('public/data/current.json', 'utf8'));
const original:Snapshot = JSON.parse(readFileSync(`public${manifest.datasetUrl}`, 'utf8'));
const stock = {...original.stocks[0],symbol:'TVTEST',close:100};
const request:ScreenerRunRequest = {universe:'mainboard',asOfDate:original.asOfDate,page:1,pageSize:15,
  expressionTree:{type:'group',operator:'all',children:[]}};
const data:Snapshot = {...original,tradingViewMetricsVersion:1,totalStocks:1,stocks:[{...stock,
  tradingview:{source:'TradingView',asOfDate:original.asOfDate,fetchedAt:'observed',updateMode:'delayed_streaming_900',
    values:Object.fromEntries(tradingViewMetrics.map(metric => [metric.id,2]))}}]};
const condition = (id:string,metric:string,isNegated=false) => ({instanceId:'tv',conditionId:id,isNegated,
  parameters:{metric,comparison:'ABOVE',value:1}});

it.each(tradingViewMetrics)('screens published $id through the matching existing category editor', metric => {
  const id = Object.keys(tradingViewFilterGroups).find(id => tradingViewFilterGroups[id].category === metric.category)!;
  const expressionTree = {type:'condition' as const,condition:condition(id,metric.id)};
  expect(supportsSnapshotCondition(expressionTree.condition)).toBe(true);
  expect(screenSnapshot(data,{...request,expressionTree})!.matchedSymbols).toEqual(['TVTEST']);
});

it('excludes stale, null and missing source values even when negated', () => {
  for (const tradingview of [undefined,{...data.stocks[0].tradingview!,asOfDate:'2000-01-01'},
    {...data.stocks[0].tradingview!,values:{'market.rvol10':null}}]) {
    for (const isNegated of [false,true]) {
      const result = screenSnapshot({...data,stocks:[{...stock,tradingview}]},{...request,
        expressionTree:{type:'condition',condition:condition('TV_PERFORMANCE','market.rvol10',isNegated)}})!;
      expect(result.matchCount).toBe(0);
      expect(result.perConditionCoverage.tv.evaluated).toBe(0);
    }
  }
});

it('rejects unknown fields and old releases instead of dropping the condition', () => {
  expect(supportsSnapshotCondition(condition('TV_PERFORMANCE','market.turnover30_crore'))).toBe(false);
  expect(supportsSnapshotCondition(condition('TV_PERFORMANCE','unknown'))).toBe(false);
  expect(() => screenSnapshot({...data,tradingViewMetricsVersion:undefined},{...request,
    expressionTree:{type:'condition',condition:condition('TV_PERFORMANCE','market.rvol10')}}))
    .toThrow(`The ${data.asOfDate} snapshot has no archived TradingView values for: Relative volume (10d, ×)`);
});

it('only offers metrics actually populated for the loaded release session', async () => {
  const snapshot = {...data,stocks:[{...stock,tradingview:{...data.stocks[0].tradingview!,
    values:{'market.rvol10':0,'market.performance_1w_pct':null}}}]};
  const result = await createSnapshotEngine(async () => snapshot)({type:'filterChoices',source:{revision:data.revision,url:'/unused'}});
  expect(result.type).toBe('filterChoices');
  if (result.type === 'filterChoices') expect(result.result.TRADINGVIEW_METRIC).toEqual(['market.rvol10']);
});

it('edits multiple TradingView rules in the shared filter modal and saves their source-specific metrics', () => {
  const apply=vi.fn();
  render(<ScreenerModal isOpen onClose={vi.fn()} activeConditionsMap={{}} matchMode="all" onApply={apply}
    choices={{SECTOR:[],INDUSTRY:[],SERIES:[],PRICE_BAND:[],INDEX_MEMBERSHIP:[],
      TRADINGVIEW_METRIC:['market.rvol10','market.performance_1w_pct']}} />);
  fireEvent.click(screen.getByRole('checkbox',{name:'Period Returns & Momentum:'}));
  const family = screen.getByRole('button',{name:'Add Period Returns & Momentum rule'}).closest('.filter-family')!;
  fireEvent.change(within(family as HTMLElement).getByRole('spinbutton',{name:'Value'}),{target:{value:'2'}});
  fireEvent.click(screen.getByRole('button',{name:'Add Period Returns & Momentum rule'}));
  const metrics=within(family as HTMLElement).getAllByRole('combobox',{name:'Metric'});
  fireEvent.change(metrics[1],{target:{value:'market.performance_1w_pct'}});
  fireEvent.click(screen.getByRole('button',{name:'Apply'}));
  const saved = Object.values(apply.mock.calls[0][0]) as Array<{conditionId:string; parameters:{metric:string; value:number}}>;
  expect(saved).toHaveLength(2);
  expect(saved.map(rule => rule.parameters.metric)).toEqual(['market.rvol10','market.performance_1w_pct']);
  expect(saved[0].parameters.value).toBe(2);
});

it('lets the same published metric be added as a result column', () => {
  localStorage.removeItem('nexus-scanner.screener.columns.v1');
  const result=screenSnapshot(data,request)!;
  render(<ResultsTable data={result} isLoading={false} isError={false} onPageChange={vi.fn()} onSortChange={vi.fn()} />);
  fireEvent.click(screen.getByRole('button',{name:'Customize columns'}));
  fireEvent.change(screen.getByRole('searchbox',{name:'Search columns'}),{target:{value:'Relative volume'}});
  fireEvent.click(screen.getByRole('checkbox',{name:'Relative volume (10d, ×)'}));
  expect(screen.getByRole('columnheader',{name:'Relative volume (10d, ×)', hidden:true})).toBeInTheDocument();
  localStorage.removeItem('nexus-scanner.screener.columns.v1');
});
