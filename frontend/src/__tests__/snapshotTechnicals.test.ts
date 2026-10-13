import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import configurations from '../data/snapshotTechnicals.json';
import { NEXUS_CONDITION_CATALOG } from '../data/conditionCatalog';
import { screenSnapshot, supportsSnapshotCondition, type Snapshot } from '../api/snapshotScreen';
import type { ScreenerRunRequest } from '../types/screener';

const manifest = JSON.parse(readFileSync('public/data/current.json','utf8'));
const data: Snapshot = JSON.parse(readFileSync(`public${manifest.datasetUrl}`,'utf8'));
const stock = {...data.stocks[0], asOfDate:data.asOfDate, historyAligned:true, metadataAsOfDate:data.asOfDate};
const run = (id:string, parameters:Record<string,unknown>, metrics = stock.metrics, negated = false) => screenSnapshot({...data,stocks:[{...stock,metrics}]}, {
  universe:'mainboard', asOfDate:data.asOfDate, page:1,pageSize:100,
  expressionTree:{type:'condition',condition:{instanceId:id,conditionId:id,parameters,isNegated:negated}},
} as ScreenerRunRequest);

it.each(configurations)('supports $id with published values and preserves missing under negation', config => {
  const def = NEXUS_CONDITION_CATALOG.find(def => def.id === config.id)!;
  const parameters = Object.fromEntries(def.parameters.map(p => [p.id,p.defaultValue]));
  expect(supportsSnapshotCondition({instanceId:config.id,conditionId:config.id,parameters})).toBe(true);
  const value = config.threshold ? Number(parameters[config.threshold]) : 1;
  expect(run(config.id, parameters, {historySessions:400,[config.id]:value})!.matchCount).toBe(1);
  for (const negated of [true,false]) {
    const missing = run(config.id,parameters,{},negated)!;
    expect(missing.matchCount).toBe(0);
    expect(missing.perConditionCoverage[config.id].evaluated).toBe(0);
    expect(missing.unavailableDiagnostics[0].affectedCount).toBe(1);
  }
});

it('uses EMA extreme-reset counters, not a naive price comparison, with warmup guards', () => {
  const params = {period:20,comparison:'ABOVE',persistDays:10};
  expect(run('PRICE_VS_EMA',params,{ema20:stock.close+1,emaAboveRun20:12,emaValid20:100})!.matchCount).toBe(1);
  expect(run('PRICE_VS_EMA',params,{emaAboveRun20:12,emaValid20:5},true)!.matchCount).toBe(0);
  expect(run('PRICE_VS_EMA',{...params,persistDays:1.5})).toBeNull();
});

it('does not round indicator facts at the filter threshold', () => {
  expect(run('ADX',{period:14,comparison:'ABOVE',value:25},{ADX:24.9999998})!.matchCount).toBe(0);
});

it('supports EMA and SMA150 stacks and sorts periods like the engine', () => {
  for (const maType of ['SMA','EMA']) {
    const metrics = {[`${maType.toLowerCase()}50`]:30,[`${maType.toLowerCase()}150`]:20,[`${maType.toLowerCase()}200`]:10};
    expect(run('MA_STACK',{maType,periods:'200,50,150',priceAbove:false},metrics)!.matchCount).toBe(1);
  }
  expect(run('MA_STACK',{maType:'EMA',periods:'50,173,200',priceAbove:false})).toBeNull();
});

it('blocks unsupported windows rather than reinterpreting their parameters', () => {
  for (const [id, parameters] of [
    ['ADX',{period:20,comparison:'ABOVE',value:25}],
    ['NEW_HIGH',{lookbackDays:20,withinDays:1}],
    ['INSIDE_BAR',{timeframe:'WEEKLY',consecutive:1,weeklyMode:'COMPLETED'}],
    ['ADX',{period:14,comparison:'CROSSES_ABOVE',value:25}],
    ['CONSECUTIVE_UP_DAYS',{minDays:1.5,withinDays:1}],
  ] as const) expect(run(id,parameters)).toBeNull();
});

it('distinguishes an old snapshot from partial coverage in a new generation', () => {
  const base: ScreenerRunRequest = {universe:'mainboard',asOfDate:data.asOfDate,page:1,pageSize:100,
    expressionTree:{type:'condition',condition:{instanceId:'adx',conditionId:'ADX',parameters:{period:14,comparison:'ABOVE',value:25}}}};
  const old = {...data,technicalMetricsVersion:undefined,stocks:[{...stock,metrics:{}}]};
  expect(screenSnapshot(old,base)!.warnings[0]).toContain('new pipeline release');
  const partial = screenSnapshot({...old,technicalMetricsVersion:1},base)!;
  expect(partial.warnings).toEqual([]);
  expect(partial.matchCount).toBe(0);
  expect(partial.unavailableDiagnostics.length).toBeGreaterThan(0);
});

it('keeps insufficient streak history and undated ban values unavailable', () => {
  expect(run('CONSECUTIVE_UP_DAYS',{minDays:10,withinDays:1},{CONSECUTIVE_UP_DAYS:0,historySessions:5},true)!.matchCount).toBe(0);
  const base: ScreenerRunRequest = {universe:'mainboard',asOfDate:data.asOfDate,page:1,pageSize:100,
    expressionTree:{type:'condition',condition:{instanceId:'ban',conditionId:'FNO_BAN',parameters:{mode:'EXCLUDE'}}}};
  expect(screenSnapshot({...data,stocks:[{...stock,fnoBan:false,fnoBanAsOfDate:'2026-10-12'}]},base)!.matchCount).toBe(0);
  expect(screenSnapshot({...data,stocks:[{...stock,fnoBan:false,fnoBanAsOfDate:data.asOfDate}]},base)!.matchCount).toBe(1);
});
