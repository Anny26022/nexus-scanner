import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { screenSnapshot, supportsSnapshotCondition, type Snapshot } from '../api/snapshotScreen';
import { snapshotFundamentals } from '../data/snapshotFundamentals';
import type { ScreenerRunRequest } from '../types/screener';

const manifest = JSON.parse(readFileSync('public/data/current.json', 'utf8'));
const snapshot: Snapshot = JSON.parse(readFileSync(`public${manifest.datasetUrl}`, 'utf8'));
const base: ScreenerRunRequest = {asOfDate:snapshot.asOfDate, universe:'mainboard', page:1, pageSize:100,
  expressionTree:{type:'group', operator:'all', children:[]}};
const run = (id: string, parameters: Record<string, unknown>, data = snapshot, negated = false) => screenSnapshot(data, {
  ...base, expressionTree:{type:'condition', condition:{instanceId:id, conditionId:id, parameters, isNegated:negated}},
});

it.each([
  ['SECTOR', {values:' healthcare '}, (s: Snapshot['stocks'][number]) => s.sector.toUpperCase() === 'HEALTHCARE', true],
  ['INDUSTRY', {values:'Tyres'}, (s: Snapshot['stocks'][number]) => s.industry === 'Tyres', true],
  ['SERIES', {values:'EQ, BE'}, (s: Snapshot['stocks'][number]) => ['EQ','BE'].includes(s.series), true],
  ['INDEX_MEMBERSHIP', {indexName:'nifty 500'}, (s: Snapshot['stocks'][number]) => s.indexMemberships.includes('NIFTY 500'), true],
  ['PRICE_CHANGE_PCT', {overDays:5, comparison:'ABOVE', pct:5}, (s: Snapshot['stocks'][number]) => s.metrics.return5 != null && s.metrics.return5 >= 5, false],
  ['GAP_UP', {withinDays:1, minGapPct:2}, (s: Snapshot['stocks'][number]) => s.metrics.gapPct != null && s.metrics.gapPct >= 2, false],
  ['GAP_DOWN', {withinDays:1, minGapPct:2}, (s: Snapshot['stocks'][number]) => s.metrics.gapPct != null && s.metrics.gapPct <= -2, false],
  ['PCT_FROM_52W_HIGH', {comparison:'BELOW', pct:5}, (s: Snapshot['stocks'][number]) => s.dist52wHighPct != null && Math.abs(s.dist52wHighPct) <= 5, false],
  ['ATR_PCT', {period:14, comparison:'ABOVE', pct:3}, (s: Snapshot['stocks'][number]) => s.atr14 != null && s.close > 0 && s.atr14 / s.close * 100 >= 3, false],
  ['ADR_PCT', {lookbackDays:20, comparison:'ABOVE', pct:2}, (s: Snapshot['stocks'][number]) => s.adr20Pct != null && s.adr20Pct >= 2, false],
  ['rs_rating', {minRsRating:80}, (s: Snapshot['stocks'][number]) => s.rsRating != null && s.rsRating >= 80, false],
  ['RS_RATING', {window:'FRONT_WEIGHTED', comparison:'ABOVE', value:80}, (s: Snapshot['stocks'][number]) => s.rsRating != null && s.rsRating >= 80, false],
  ['FF_MARKETCAP', {comparison:'ABOVE', valueCr:500}, (s: Snapshot['stocks'][number]) => s.marketCapCrore != null && s.freeFloatPct != null && s.marketCapCrore * s.freeFloatPct / 100 >= 500, true],
] as const)('evaluates %s across the published universe before pagination', (id, params, predicate, metadata) => {
  const expected = snapshot.stocks.filter(s => (metadata ? s.metadataAsOfDate === snapshot.asOfDate : s.historyAligned && s.asOfDate === snapshot.asOfDate)
    && s.close != null && predicate(s));
  expect(run(id, params)!.matchCount).toBe(expected.length);
});

it.each(snapshotFundamentals)('compares published $value without new data', ({value, field}) => {
  const expected = snapshot.stocks.filter(s => s.metadataAsOfDate === snapshot.asOfDate && s.close != null
    && typeof s[field] === 'number' && Number.isFinite(s[field]) && Number(s[field]) >= 1);
  expect(run('FUNDAMENTAL_METRIC', {metric:value, comparison:'ABOVE', value:1})!.matchCount).toBe(expected.length);
});

it('preserves unavailable values under negation and rejects stale scalar data', () => {
  const stock = {...snapshot.stocks[0], historyAligned:true, asOfDate:snapshot.asOfDate, metadataAsOfDate:snapshot.asOfDate,
    close:100, atr14:null, rsRating:null, freeFloatPct:null, pbRatio:null};
  const data = {...snapshot, stocks:[stock]};
  for (const [id, params] of [
    ['ATR_PCT', {period:14, comparison:'BELOW', pct:5}], ['rs_rating', {minRsRating:1}],
    ['FF_MARKETCAP', {comparison:'BELOW', valueCr:100}], ['FUNDAMENTAL_METRIC', {metric:'PB_RATIO', comparison:'BELOW', value:10}],
  ] as const) expect(run(id, params, data, true)!.matchCount).toBe(0);
  expect(run('ATR_PCT', {period:14, comparison:'ABOVE', pct:1}, {...data, stocks:[{...stock, atr14:5, metadataAsOfDate:'2000-01-01'}]})!.matchCount).toBe(0);
  expect(run('INDEX_MEMBERSHIP', {indexName:'NIFTY 500'}, {...data, stocks:[{...stock, indexMemberships:[]}]}, true)!.matchCount).toBe(0);
});

it('uses supported SMA periods and leaves absent richer snapshot values unknown', () => {
  const stock = {...snapshot.stocks[0], close:100, historyAligned:true, asOfDate:snapshot.asOfDate,
    metrics:{sma10:90, sma20:80, sma50:70, sma200:60}};
  const data = {...snapshot, stocks:[stock]};
  expect(run('MA_STACK', {periods:'20,50,200', maType:'SMA', priceAbove:true}, data)!.matchCount).toBe(1);
  expect(run('trend_ma_stack', {stackOrder:'10_above_20_above_50'}, data)!.matchCount).toBe(1);
  for (const parameters of [{periods:'50,150,200', maType:'SMA'}, {periods:'20,50,200', maType:'EMA'}]) {
    const result = run('MA_STACK', parameters, data)!;
    expect(result.matchCount).toBe(0);
    expect(result.perConditionCoverage.MA_STACK.evaluated).toBe(0);
    expect(result.warnings).toHaveLength(1);
  }
});

it('normalizes circuit bands and handles No Band separately from missing values', () => {
  const data = {...snapshot, stocks:['5%', '20', 'No Band', ''].map((circuitLimit, index) => ({...snapshot.stocks[0],
    symbol:String(index), circuitLimit, metadataAsOfDate:snapshot.asOfDate}))};
  expect(run('PRICE_BAND', {values:'5, No Band'}, data)!.matchCount).toBe(2);
  expect(run('CIRCUIT_BAND_MIN', {minBandPct:20}, data)!.matchCount).toBe(2);
  expect(run('CIRCUIT_BAND_MIN', {minBandPct:20}, data, true)!.matchCount).toBe(1);
});

it.each([
  ['ADR_PCT', {lookbackDays:14}], ['ATR_PCT', {period:20}], ['GAP_UP', {withinDays:3}],
  ['PRICE_CHANGE_PCT', {overDays:10}], ['RS_RATING', {window:'TWELVE_MONTH'}],
])('keeps unsupported %s configurations blocked', (id, parameters) => {
  expect(supportsSnapshotCondition({instanceId:id, conditionId:id, parameters})).toBe(false);
});
