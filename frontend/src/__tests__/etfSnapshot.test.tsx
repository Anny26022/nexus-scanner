import {expect, it, vi} from 'vitest';
import {fireEvent, render, screen, within} from '@testing-library/react';
import {createSnapshotEngine} from '../api/snapshotEngine';
import {screenSnapshot, type Snapshot, type SnapshotStock} from '../api/snapshotScreen';
import {manifestSnapshotSource, type Manifest} from '../api/manifest';
import {ScreenerModal} from '../components/ScreenerModal';
import {parseScreenDefinition} from '../utils/savedScreens';
import type {ActiveCondition, ScreenerRunRequest} from '../types/screener';

const revision = 'a'.repeat(64), date = '2026-10-23';
const snapshot: Snapshot = {revision, asOfDate:date, totalStocks:3, assetType:'etf',
  stocks:[['GOLD',.5,'gold'],['NIFTY',.1,'equity'],['UNKNOWN',null,null]].map(([symbol, expense, asset]) => ({
    symbol, name:symbol, close:100, asOfDate:date, metadataAsOfDate:date, historyAligned:false,
    indexMemberships:[], metrics:{}, presetMatches:{}, etf:{expense_ratio:expense, asset_class:asset},
  } as unknown as SnapshotStock)), etfLabels:{asset_class:{gold:'Commodities',equity:'Equity'}}};
const request: ScreenerRunRequest = {universe:'etf', asOfDate:date, page:1, pageSize:15,
  expressionTree:{type:'group', operator:'all', children:[]}};
const expense: ActiveCondition = {instanceId:'fee', conditionId:'ETF_ExpenseRatio',
  parameters:{metric:'expense_ratio',comparison:'BELOW',value:.2}};

it('screens, exports, and reports missing coverage without treating null as zero', () => {
  const run = {...request, expressionTree:{type:'condition' as const,condition:expense}};
  const data = screenSnapshot(snapshot,run)!;
  expect(data.rows.map(row => row.symbol)).toEqual(['NIFTY']);
  expect(data.perConditionCoverage.fee).toMatchObject({evaluated:2,matched:1});
  expect(screenSnapshot(snapshot,{...run, pageSize:1},true)?.rows).toHaveLength(1);
});
it('keeps negated missing values unavailable and excludes stale quote metrics', () => {
  const data = {...snapshot, stocks:snapshot.stocks.map(row => row.symbol === 'GOLD' ? {...row,asOfDate:'2026-10-22'} : row)};
  expect(screenSnapshot(data,{...request,expressionTree:{type:'condition',condition:{...expense,isNegated:true}}})?.rows).toEqual([]);
  expect(() => screenSnapshot(snapshot,{...request,universe:'mainboard'})).toThrow('universe mismatch');
  expect(() => screenSnapshot(snapshot,{...request,textQuery:'PE < 20'})).toThrow('ETF filters');
});
it('sorts ETF numeric columns and preserves timeframe-qualified sorts in saved screens', () => {
  expect(screenSnapshot(snapshot,{...request,sort:{field:'etf.expense_ratio',direction:'desc'}})?.rows.map(row => row.symbol))
    .toEqual(['GOLD','NIFTY','UNKNOWN']);
  expect(parseScreenDefinition({universe:'etf',conditions:{},matchMode:'all',query:'',sort:{field:'etf.RSI|15',direction:'desc'}}))
    .not.toBeNull();
});
it('isolates ETF and stock caches even when the release revision is identical', async () => {
  const loader=vi.fn(async(source) => source.url.includes('etfs') ? snapshot : {...snapshot, assetType:undefined});
  const run=createSnapshotEngine(loader);
  await run({type:'warm',source:{revision,url:'/stocks.json'}});
  const choices=await run({type:'filterChoices',source:{revision,url:'/etfs.json.gz'}});
  expect(loader).toHaveBeenCalledTimes(2);
  expect(choices).toMatchObject({type:'filterChoices',result:{ETF_FIELDS:expect.arrayContaining(['expense_ratio']),
    ETF_VALUES:{asset_class:['equity','gold']},ETF_LABELS:snapshot.etfLabels}});
  await run({type:'screen',source:{revision,url:'/etfs.json.gz'},request});
  expect(loader).toHaveBeenCalledTimes(2);
});
it('allows only the latest ETF snapshot and gives older releases a clear error', () => {
  const manifest = {revision,sessionDate:date,etfDatasetUrl:'/data/revisions/current/etfs.json.gz',
    objectUrlTemplate:'https://data.example/objects/{hash}.json.gz'} as Manifest;
  expect(manifestSnapshotSource(manifest, revision, date, true).url).toBe(manifest.etfDatasetUrl);
  expect(() => manifestSnapshotSource(manifest,'b'.repeat(64),'2026-10-22',true)).toThrow('only the latest');
  expect(() => manifestSnapshotSource(manifest,revision,'2026-10-22',true)).toThrow('only the latest');
  expect(() => manifestSnapshotSource(manifest,'b'.repeat(64),date,true)).toThrow('only the latest');
  expect(() => manifestSnapshotSource({...manifest,etfDatasetUrl:undefined},revision,date,true)).toThrow('daily refresh');
  expect(parseScreenDefinition({universe:'etf',conditions:{fee:expense},matchMode:'all',query:'',sort:{field:'symbol',direction:'asc'}})).not.toBeNull();
});
it('reuses the filter dialog with ETF categories, numeric comparisons and labelled choices', () => {
  const apply=vi.fn();
  render(<ScreenerModal etf isOpen onClose={vi.fn()} activeConditionsMap={{}} matchMode="all" onApply={apply}
    choices={{SECTOR:[],INDUSTRY:[],SERIES:[],PRICE_BAND:[],INDEX_MEMBERSHIP:[],
      ETF_FIELDS:['asset_class','expense_ratio'], ETF_VALUES:{asset_class:['equity','gold']}, ETF_LABELS:snapshot.etfLabels}} />);
  expect(screen.queryByRole('button',{name:'Pre-built Scans'})).not.toBeInTheDocument();
  const fee=screen.getByRole('checkbox',{name:'Expense ratio %:'});
  fireEvent.click(fee);
  const row=fee.closest('.filter-row')!;
  fireEvent.change(within(row as HTMLElement).getByRole('spinbutton'),{target:{value:'.2'}});
  const asset=screen.getByRole('checkbox',{name:'Asset class:'});
  fireEvent.click(asset);
  fireEvent.click(within(asset.closest('.filter-row') as HTMLElement).getByRole('button',{name:'Values: Select options'}));
  expect(screen.getByRole('checkbox',{name:'Commodities'})).toBeInTheDocument();
  fireEvent.click(screen.getByRole('checkbox',{name:'Commodities'}));
  fireEvent.keyDown(screen.getByRole('textbox',{name:'Search Values'}),{key:'Escape'});
  fireEvent.click(screen.getByRole('button',{name:'Apply'}));
  expect(apply.mock.calls[0][0].ETF_ExpenseRatio.parameters.value).toBe(.2);
  expect(apply.mock.calls[0][0].ETF_AssetClass.parameters.values).toEqual(['gold']);
});
