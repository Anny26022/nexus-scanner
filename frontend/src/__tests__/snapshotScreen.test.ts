import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { screenSnapshot, type Snapshot } from '../api/snapshotScreen';
import { supportsSnapshotCondition } from '../api/snapshotScreen';
import type { ScreenerRunRequest } from '../types/screener';

const manifest = JSON.parse(readFileSync('public/data/current.json','utf8'));
const snapshot: Snapshot = JSON.parse(readFileSync(`public${manifest.datasetUrl}`,'utf8'));
const condition = (id: string, parameters = {}) => ({type:'condition' as const,condition:{instanceId:id,conditionId:id,parameters}});
const request: ScreenerRunRequest = {asOfDate:snapshot.asOfDate,universe:'mainboard',page:1,pageSize:15,
  expressionTree:{type:'group',operator:'all',children:[condition('mom_rvol',{minRvol:1.5,maxRvol:20}),condition('trend_price_vs_ma',{maType:'SMA',maPeriod:50,operator:'above',thresholdPct:0})]}};

afterEach(() => vi.unstubAllGlobals());
describe('published snapshots', () => {
  it('uses published preset results and keeps absent results unknown without geometry fallbacks', () => {
    const id = 'lib-ms-vcp';
    const stock = {...snapshot.stocks[0], historyAligned:true, asOfDate:snapshot.asOfDate,
      setupGeometry:{vcp:{matched:true}}, isLiquidScreen:true, presetMatches:{}, presetRuleMatches:{}};
    const run = (input: typeof stock, negated = false) => {
      const expression = condition(id);
      return screenSnapshot({...snapshot, stocks:[input]}, {...request,
        expressionTree:{...expression,condition:{...expression.condition,isNegated:negated}}})!;
    };
    expect(run(stock).matchCount).toBe(0);
    expect(run(stock, true).matchCount).toBe(0);
    expect(run(stock).perConditionCoverage[id].evaluated).toBe(0);
    expect(run({...stock,presetMatches:{[id]:true}}).matchCount).toBe(1);
    expect(run({...stock,presetMatches:{[id]:false}}).matchCount).toBe(0);
  });
  it('searches symbols and company names across all matches before pagination', () => {
    const stocks = [
      {...snapshot.stocks[0], symbol:'OTHER', name:'Other Company'},
      {...snapshot.stocks[0], symbol:'GLAXO', name:'GlaxoSmithKline Pharmaceuticals'},
      {...snapshot.stocks[0], symbol:'GLAXONEW', name:'New Company'},
    ];
    const data = {...snapshot, stocks};
    const base = {...request, expressionTree:{type:'group' as const, operator:'all' as const, children:[]}, pageSize:1};
    const result = screenSnapshot(data, {...base, symbolSearch:' glaxo '})!;
    expect(result.matchCount).toBe(2);
    expect(result.rows[0].symbol).toBe('GLAXO');
    expect(result.matchedSymbols).toEqual(['GLAXO','GLAXONEW']);
    const second = screenSnapshot(data, {...base, symbolSearch:'glaxo', page:2})!;
    expect(second.rows[0].symbol).toBe('GLAXONEW');
    expect(second.matchedSymbols).toEqual(result.matchedSymbols);
    expect(screenSnapshot(data, {...base, symbolSearch:'pharmaceuticals'})!.rows[0].symbol).toBe('GLAXO');
    expect(screenSnapshot(data, {...base, symbolSearch:'no match'})!.matchCount).toBe(0);
    expect(screenSnapshot(data, base)!.matchCount).toBe(3);
    const exported = screenSnapshot(data, {...base,page:2,symbolSearch:'glaxo'}, true)!;
    expect(exported.rows.map(row=>row.symbol)).toEqual(['GLAXO','GLAXONEW']);
    expect(screenSnapshot(data, {...base,page:2,symbolSearch:'glaxo'})!.rows).toHaveLength(1);
  });
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
    expect(result.matchedSymbols).toHaveLength(2);
    expect(new Set(result.matchedSymbols)).toEqual(new Set(wanted));
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
  it('applies optional eligibility to rule-only matches, including removals, strict boundaries and unknowns', () => {
    const id = 'lib-easy-money';
    const stock = {...snapshot.stocks[0],symbol:'LOW',close:5,marketCapCrore:100,
      metrics:{turnover50:1},historyAligned:true,asOfDate:snapshot.asOfDate,metadataAsOfDate:snapshot.asOfDate,
      presetMatches:{[id]:false},presetRuleMatches:{[id]:true}};
    const data: Snapshot = {...snapshot,presetRuleMatchesVersion:1,stocks:[stock]};
    const run = (parameters = {}, input: Snapshot = data, negated = false) => {
      const expression = condition(id, parameters);
      return screenSnapshot(input,{...request,expressionTree:{...expression,condition:{...expression.condition,isNegated:negated}}})!;
    };
    expect(run().matchCount).toBe(0);
    expect(run({minMarketCapCr:50,minPrice:0,minTurnoverCr:0}).matchedSymbols).toEqual(['LOW']);
    expect(run({minMarketCapCr:100,minPrice:null,minTurnoverCr:null}).matchCount).toBe(0);
    expect(run({minMarketCapCr:null,minPrice:5,minTurnoverCr:null}).matchCount).toBe(0);
    expect(run({minMarketCapCr:null,minPrice:null,minTurnoverCr:1}).matchCount).toBe(0);
    const removed = {minMarketCapCr:null,minPrice:null,minTurnoverCr:null};
    expect(run(removed).matchCount).toBe(1);
    const missing = {...data,stocks:[{...stock,metrics:{turnover50:null}}]};
    expect(run({minMarketCapCr:null,minPrice:null}, missing).matchCount).toBe(0);
    expect(run({minMarketCapCr:null,minPrice:null}, missing, true).matchCount).toBe(0);
    expect(run(removed, missing).matchCount).toBe(1);
    const noSignal = {...data,stocks:[{...stock,presetRuleMatches:{[id]:false}}]};
    expect(run(removed, noSignal).matchCount).toBe(0);
    expect(run(removed, noSignal, true).matchCount).toBe(1);
    const stale = {...data,stocks:[{...stock,asOfDate:'2000-01-01'}]};
    expect(run(removed, stale, true).matchCount).toBe(0);
    expect(() => run(removed, {...data,presetRuleMatchesVersion:undefined})).toThrow('newer dataset');
    expect(run({}, {...data,presetRuleMatchesVersion:undefined}).matchCount).toBe(0);
    for (const minPrice of ['',-1,Infinity,true]) {
      expect(supportsSnapshotCondition({instanceId:id,conditionId:id,parameters:{minPrice}})).toBe(false);
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
  it('rejects stocks with historyAligned: false in preset fallback and evaluation', () => {
    const unalignedStock = { ...snapshot.stocks[0], historyAligned: false };
    const unalignedSnapshot = { ...snapshot, stocks: [unalignedStock] };
    const vcpCond = condition('lib-ms-vcp', {});
    expect(screenSnapshot(unalignedSnapshot, { ...request, expressionTree: vcpCond })?.matchCount).toBe(0);
    // Under negation, unknown/null remains unknown (0 matches)
    expect(screenSnapshot(unalignedSnapshot, { ...request, expressionTree: { ...vcpCond, condition: { ...vcpCond.condition, isNegated: true } } })?.matchCount).toBe(0);
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
