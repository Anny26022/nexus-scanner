import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { screenSnapshot, type Snapshot } from '../api/snapshotScreen';
import type { ScreenerRunRequest } from '../types/screener';

const manifest = JSON.parse(readFileSync('public/data/current.json','utf8'));
const snapshot: Snapshot = JSON.parse(readFileSync(`public${manifest.datasetUrl}`,'utf8'));
const condition = (id: string, parameters = {}) => ({type:'condition' as const,condition:{instanceId:id,conditionId:id,parameters}});
const request: ScreenerRunRequest = {asOfDate:snapshot.asOfDate,universe:'mainboard',page:1,pageSize:15,
  expressionTree:{type:'group',operator:'all',children:[condition('mom_rvol',{minRvol:1.5,maxRvol:20}),condition('trend_price_vs_ma',{maType:'SMA',maPeriod:50,operator:'above',thresholdPct:0})]}};

afterEach(() => vi.unstubAllGlobals());
describe('published snapshots', () => {
  it('matches the verified history screen without rounding RVOL at the threshold', () => {
    const response = screenSnapshot(snapshot,request)!;
    expect(response.matchCount).toBe(snapshot.referenceCounts!.rvol15Sma50);
    expect(response.immutableRevision).toBe(manifest.revision);
    const below = {...snapshot.stocks[0],rvol:1.496580446,asOfDate:snapshot.asOfDate,historyAligned:true,metrics:{sma50:0}};
    expect(screenSnapshot({...snapshot,stocks:[below]},request)!.matchCount).toBe(0);
  });
  it('intersects announcement matches before pagination and keeps filters out of each other’s cache', () => {
    const base = {...request, expressionTree:{type:'group' as const, operator:'all' as const, children:[]}, pageSize:1};
    const wanted = snapshot.stocks.slice(0, 2).map(stock => stock.symbol);
    const result = screenSnapshot(snapshot, {...base, announcementSymbols:wanted})!;
    expect(result.matchCount).toBe(2);
    expect(result.rows).toHaveLength(1);
    expect(screenSnapshot(snapshot, {...base, announcementSymbols:[]})!.matchCount).toBe(0);
    expect(screenSnapshot(snapshot, base)!.matchCount).toBe(snapshot.stocks.filter(stock => stock.close != null).length);
  });
  it('uses all 45 authoritative preset results', () => {
    const presets = Object.keys(snapshot.stocks[0].presetMatches);
    expect(presets).toHaveLength(45);
    for (const id of presets) {
      const result = screenSnapshot(snapshot,{...request,expressionTree:condition(id)})!;
      expect(result.matchCount).toBe(snapshot.stocks.filter(s => s.presetMatches[id] === true).length);
    }
  });
  it('falls back for custom history settings and preserves unknown under negation', () => {
    expect(screenSnapshot(snapshot,{...request,expressionTree:condition('PRICE_VS_SMA',{period:50,persistDays:10,comparison:'ABOVE'})})).toBeNull();
    const missing = {...snapshot.stocks[0],historyAligned:true,asOfDate:snapshot.asOfDate,rvol:null};
    const expr = condition('mom_rvol',{minRvol:1.5,maxRvol:20});
    expect(screenSnapshot({...snapshot,stocks:[missing]},{...request,expressionTree:{...expr,condition:{...expr.condition,isNegated:true}}})!.matchCount).toBe(0);
  });
  it('filters ASM and GSM stocks in the browser snapshot without an API round trip', () => {
    const clear = {...snapshot.stocks[0],surveillanceAvailable:true,surveillanceAsOfDate:snapshot.asOfDate,isAsm:false,isGsm:false};
    const asm = {...clear,symbol:'ASM',isAsm:true,asmStage:'LTASM - I'};
    const gsm = {...clear,symbol:'GSM',isGsm:true,gsmStage:'GSM Stage 2'};
    const unavailable = {...clear,symbol:'UNKNOWN',surveillanceAvailable:false,isAsm:null,isGsm:null};
    const result = screenSnapshot(
      {...snapshot,stocks:[clear,asm,gsm,unavailable]},
      {...request,expressionTree:condition('EXCLUDE_SURVEILLANCE')},
    );
    expect(result?.matchCount).toBe(1);
    expect(result?.rows.map(stock => stock.symbol)).toEqual([clear.symbol]);
  });
  it('evaluates published current fundamental metrics in the browser snapshot', () => {
    const stock = {...snapshot.stocks[0],roePct:18,epsLastYear:12,epsTwoYearsBack:10,metadataAsOfDate:snapshot.asOfDate};
    expect(screenSnapshot({...snapshot,stocks:[stock]},{...request,expressionTree:condition('FUNDAMENTAL_METRIC',{metric:'ROE',comparison:'ABOVE',value:15})})?.matchCount).toBe(1);
    expect(screenSnapshot({...snapshot,stocks:[stock]},{...request,expressionTree:condition('EPS_LAST_YEAR_HIGHER')})?.matchCount).toBe(1);
  });
  it('connects newly published values and leaves missing or stale data unknown', () => {
    const stock = {...snapshot.stocks[0],metadataAsOfDate:snapshot.asOfDate,
      interestCoverage:5,totalRevenueLakh:1200,dividendPerShare:2,
      vwap:100,vwapAsOfDate:snapshot.asOfDate,allTimeHigh:null,return5yPct:null};
    for (const metric of ['INTEREST_COVERAGE','TOTAL_REVENUE_IN_LAKHS','DIVIDEND_PER_SHARE_LATEST','VWAP']) {
      expect(screenSnapshot({...snapshot,stocks:[stock]},{...request,expressionTree:condition('FUNDAMENTAL_METRIC',{metric,comparison:'ABOVE',value:1})})?.matchCount).toBe(1);
    }
    for (const metric of ['ALL_TIME_HIGH','RETURN_5Y']) {
      expect(screenSnapshot({...snapshot,stocks:[stock]},{...request,expressionTree:condition('FUNDAMENTAL_METRIC',{metric,comparison:'ABOVE',value:1})})?.matchCount).toBe(0);
    }
    expect(screenSnapshot({...snapshot,stocks:[{...stock,vwapAsOfDate:'2000-01-01'}]},{...request,
      expressionTree:condition('FUNDAMENTAL_METRIC',{metric:'VWAP',comparison:'ABOVE',value:1})})?.matchCount).toBe(0);
    const stale = condition('FUNDAMENTAL_METRIC',{metric:'VWAP',comparison:'ABOVE',value:1});
    expect(screenSnapshot({...snapshot,stocks:[{...stock,vwapAsOfDate:'2000-01-01'}]},{...request,
      expressionTree:{...stale,condition:{...stale.condition,isNegated:true}}})?.matchCount).toBe(0);
    const staleMetadata = {...stock,metadataAsOfDate:'2000-01-01'};
    expect(screenSnapshot({...snapshot,stocks:[staleMetadata]},{...request,
      expressionTree:condition('FUNDAMENTAL_METRIC',{metric:'DIVIDEND_PER_SHARE_LATEST',comparison:'ABOVE',value:1})})?.matchCount).toBe(1);
    const staleFundamental = condition('FUNDAMENTAL_METRIC',{metric:'INTEREST_COVERAGE',comparison:'ABOVE',value:1});
    expect(screenSnapshot({...snapshot,stocks:[staleMetadata]},{...request,
      expressionTree:staleFundamental})?.matchCount).toBe(0);
    expect(screenSnapshot({...snapshot,stocks:[staleMetadata]},{...request,
      expressionTree:{...staleFundamental,condition:{...staleFundamental.condition,isNegated:true}}})?.matchCount).toBe(0);
  });
  it('refreshes a same-session correction and pins Python fallback to that revision', async () => {
    vi.resetModules();
    const revision = 'a'.repeat(64), next = 'b'.repeat(64);
    const data = {...snapshot,totalStocks:1,revision,stocks:[{...snapshot.stocks[0],rvol:2,metrics:{sma50:0}}]};
    const corrected = {...data,revision:next,stocks:[{...data.stocks[0],rvol:1}]};
    let current = revision;
    const fetcher = vi.fn(async (url: string, options?: RequestInit) => {
      if (url === '/data/current.json') return new Response(JSON.stringify({...manifest,datasetGzipUrl:undefined,datasetPackedGzipUrl:undefined,datasetUrl:`/data/revisions/${current}/stocks.json`,revision:current}));
      if (url.includes(`/revisions/${revision}/stocks.json`)) return new Response(JSON.stringify(data));
      if (url.includes(`/revisions/${next}/stocks.json`)) return new Response(JSON.stringify(corrected));
      expect(options?.method).toBe('POST');
      const body = JSON.parse(options!.body as string);
      expect(body.datasetRevision).toBe(next);
      expect(body.asOfDate).toBe(snapshot.asOfDate);
      return new Response(JSON.stringify({...screenSnapshot(corrected,request),immutableRevision:next,rows:[]}));
    });
    vi.stubGlobal('fetch',fetcher);
    const {realAdapter} = await import('../api/realAdapter');
    await realAdapter.getCurrentRevision();
    expect((await realAdapter.runScreen({...request,datasetRevision:revision})).matchCount).toBe(1);
    current = next;
    expect((await realAdapter.getCurrentRevision()).immutableRevision).toBe(next);
    expect((await realAdapter.runScreen({...request,datasetRevision:next})).matchCount).toBe(0);
    await realAdapter.runScreen({...request,datasetRevision:next,expressionTree:condition('ADX',{period:14,value:25,comparison:'ABOVE'})});
    expect(fetcher.mock.calls.filter(([url]) => url.includes('/stocks.json'))).toHaveLength(2);
  });
});
