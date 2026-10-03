import { afterEach, expect, it, vi } from 'vitest';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { createSnapshotEngine } from '../api/snapshotEngine';
import type { Snapshot } from '../api/snapshotScreen';
import type { ScreenerRunRequest } from '../types/screener';
const snapshot:Snapshot={revision:'a'.repeat(64),asOfDate:'2026-10-01',totalStocks:60,
 stocks:Array.from({length:60},(_,i)=>({symbol:`TEST${String(i).padStart(2,'0')}`,
 name:'Test company',listingDate:'2020-01-01',sector:'Test',industry:'Test',series:'EQ',
 close:100,changePct:0,open:100,high:101,low:99,volume:1000,rupeeVolumeCrore:1,
 rvol:1,marketCapCrore:100,peRatio:null,rsi14:null,adr20Pct:null,atr14:null,
 sma20:null,sma50:null,sma200:null,ema20:null,ema50:null,ema200:null,
 dist52wHighPct:null,dist52wLowPct:null,distAthPct:null,earningsDate:null,daysSinceEarnings:null,
 fnoBan:false,isFno:false,circuitLimit:'20',deliveryPct:null,rsRating:null,dataCompleteness:100,asOfDate:'2026-10-01',metadataAsOfDate:'2026-10-01',
 historyAligned:true,indexMemberships:[],metrics:{},presetMatches:{},roePct:null,freeFloatPct:null}))};
const source={revision:snapshot.revision,url:'/stocks.json'};
const request:ScreenerRunRequest={asOfDate:snapshot.asOfDate,universe:'mainboard',page:1,pageSize:50,
  expressionTree:{type:'group',operator:'all',children:[]},sort:{field:'symbol',direction:'asc'}};
afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers();vi.resetModules();});
it('loads a revision once for concurrent screen and comparison tasks',async()=>{
 const loader=vi.fn(async()=>snapshot),run=createSnapshotEngine(loader);
 const [page,comparison]=await Promise.all([
  run({type:'screen',source,request}),run({type:'compare',source,symbols:[snapshot.stocks[0].symbol,'NOT_A_STOCK']})]);
 expect(loader).toHaveBeenCalledTimes(1);
 expect(page.type).toBe('screen');
 if(comparison.type==='compare') expect(comparison.result.invalidSymbols).toEqual(['NOT_A_STOCK']);
});
it('reuses matches when only pagination changes',async()=>{
 const stocks=[...snapshot.stocks];
 const filter=vi.spyOn(stocks,'filter');
 const run=createSnapshotEngine(async()=>({...snapshot,stocks}));
 const a=await run({type:'screen',source,request});
 const b=await run({type:'screen',source,request:{...request,page:2}});
 expect(filter).toHaveBeenCalledTimes(1);
 if(a.type==='screen'&&b.type==='screen') {
  expect(a.result?.matchCount).toBe(b.result?.matchCount);
  expect(b.result?.page).toBe(2);
  expect(a.result?.rows).toHaveLength(50);
  expect(b.result?.rows).toHaveLength(10);
  expect(b.result?.rows.map(row=>row.symbol)).toEqual(snapshot.stocks.slice(50).map(row=>row.symbol));
 }
 await run({type:'screen',source,request:{...request,sort:{field:'symbol',direction:'desc'}}});
 expect(filter).toHaveBeenCalledTimes(2);
});
it('retries a failed load and evicts old revisions',async()=>{
 const loader=vi.fn().mockRejectedValueOnce(new Error('offline')).mockImplementation(async(s)=>({...snapshot,revision:s.revision}));
 const run=createSnapshotEngine(loader);
 await expect(run({type:'screen',source,request})).rejects.toThrow('offline');
 await run({type:'screen',source,request});
 for(const id of ['b','c'])await run({type:'screen',source:{...source,revision:id.repeat(64)},request});
 await run({type:'screen',source,request});
 expect(loader).toHaveBeenCalledTimes(5);
});
it('unsupported conditions retain revision metadata for server fallback',async()=>{
 const run=createSnapshotEngine(async()=>snapshot);
 const result=await run({type:'screen',source,request:{...request,expressionTree:{type:'condition',condition:{instanceId:'x',conditionId:'PRICE_VS_SMA',parameters:{period:50,persistDays:10,comparison:'ABOVE'}}}}});
 expect(result.type==='screen'&&result.result).toBeNull();
 expect(result.type==='screen'&&result.revision).toBe(snapshot.revision);
});
it('fetches and decodes advertised gzip snapshots',async()=>{
 const compressed=gzipSync(JSON.stringify(snapshot));
 vi.stubGlobal('DecompressionStream',(await import('node:stream/web')).DecompressionStream);
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(compressed)));
 const result=await createSnapshotEngine()({type:'screen',source:{...source,url:'/stocks.json.gz'},request});
 expect(result.type==='screen'&&result.result?.matchCount).toBe(snapshot.totalStocks);
});
it('loads only the public packs required by the expression',async()=>{
 const revision='d'.repeat(64),row=snapshot.stocks[0],pack=(stocks:Record<string,unknown>[])=>gzipSync(JSON.stringify({schemaVersion:7,revision,asOfDate:snapshot.asOfDate,totalStocks:1,stocks}));
 const bytes={core:pack([{...row,marketCapCrore:undefined}]),technical:pack([{symbol:row.symbol,rvol:2}]),fundamentals:pack([{symbol:row.symbol,marketCapCrore:5000}])};
 const descriptors=Object.fromEntries(Object.entries(bytes).map(([name,data])=>[name,{url:`/${name}.json.gz`,bytes:data.byteLength,sha256:createHash('sha256').update(data).digest('hex'),encoding:'gzip',schemaVersion:7}])) as any;
 vi.stubGlobal('DecompressionStream',(await import('node:stream/web')).DecompressionStream);
 const fetcher=vi.fn(async(url:string)=>new Response(bytes[url.slice(1,-8) as keyof typeof bytes]));vi.stubGlobal('fetch',fetcher);
 const localRequest={...request,datasetRevision:revision,expressionTree:{type:'condition' as const,condition:{instanceId:'cap',conditionId:'MARKETCAP',parameters:{comparison:'ABOVE',valueCr:1000,reportType:'PREFER_CONSOLIDATED'}}}};
 const result=await createSnapshotEngine()({type:'screen',source:{revision,sessionDate:snapshot.asOfDate,packs:descriptors},request:localRequest});
 expect(result.type==='screen'&&result.result?.matchCount).toBe(1);
 expect(fetcher.mock.calls.map(call=>call[0])).toEqual(['/core.json.gz','/fundamentals.json.gz']);
});
it('rejects snapshot session mismatches',async()=>{
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify(snapshot))));
 await expect(createSnapshotEngine()({type:'screen',source:{...source,sessionDate:'2020-01-01'},request})).rejects.toThrow('revision/session mismatch');
});
it('routes concurrent worker replies by id and rejects pending tasks on failure',async()=>{
 class TestWorker {
  static last:TestWorker;
  onmessage?: (event:any)=>void; onerror?:()=>void;
  onmessageerror?:()=>void;
  tasks:any[]=[];terminate=vi.fn();
  constructor(){TestWorker.last=this;}
  postMessage(message:any){this.tasks.push(message);}
 }
 vi.stubGlobal('Worker',TestWorker);
 const {runSnapshotTask}=await import('../api/snapshotClient');
 const first=runSnapshotTask({type:'screen',source,request});
 const second=runSnapshotTask({type:'screen',source,request:{...request,page:2}});
 const worker=TestWorker.last;
 const result={type:'screen',result:null,revision:source.revision,sessionDate:snapshot.asOfDate};
 worker.onmessage!({data:{id:worker.tasks[1].id,result}});
 await expect(second).resolves.toEqual(result);
 const failure=expect(first).rejects.toThrow('worker failed');worker.onerror!();await failure;
 expect(worker.terminate).toHaveBeenCalledOnce();
});
it('uses fallback when module-worker construction is blocked',async()=>{
 const constructor=vi.fn(function(){throw new Error('CSP blocked');});
 vi.stubGlobal('Worker',constructor);
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify(snapshot))));
 const {runSnapshotTask}=await import('../api/snapshotClient');
 await expect(runSnapshotTask({type:'screen',source,request})).resolves.toMatchObject({type:'screen'});
 await expect(runSnapshotTask({type:'compare',source,symbols:['TEST00']})).resolves.toMatchObject({type:'compare'});
 expect(constructor).toHaveBeenCalledTimes(1);
});
it('times out stalled fallback and loads a fresh engine on retry',async()=>{
 vi.useFakeTimers();vi.stubGlobal('Worker',undefined);
 const fetcher=vi.fn().mockImplementationOnce(()=>new Promise(()=>{}))
  .mockResolvedValue(new Response(JSON.stringify(snapshot)));
 vi.stubGlobal('fetch',fetcher);
 const {runSnapshotTask}=await import('../api/snapshotClient');
 const first=runSnapshotTask({type:'screen',source,request});
 const failure=expect(first).rejects.toThrow('timed out');
 await vi.waitFor(()=>expect(fetcher).toHaveBeenCalledTimes(1));
 await vi.advanceTimersByTimeAsync(60000);await failure;
 await expect(runSnapshotTask({type:'screen',source,request})).resolves.toMatchObject({type:'screen'});
 expect(fetcher).toHaveBeenCalledTimes(2);
});
it('keeps newer pending tasks alive when one worker task times out',async()=>{
 vi.useFakeTimers();
 class TestWorker {
  static last:TestWorker;
  onmessage?: (event:any)=>void;
  tasks:any[]=[];terminate=vi.fn();
  constructor(){TestWorker.last=this;}
  postMessage(message:any){this.tasks.push(message);}
 }
 vi.stubGlobal('Worker',TestWorker);
 const {runSnapshotTask}=await import('../api/snapshotClient');
 const first=runSnapshotTask({type:'screen',source,request});
 const failure=expect(first).rejects.toThrow('timed out');
 await vi.advanceTimersByTimeAsync(30000);
 const second=runSnapshotTask({type:'compare',source,symbols:['TEST00']});
 await vi.advanceTimersByTimeAsync(30000);await failure;
 const worker=TestWorker.last;
 expect(worker.terminate).not.toHaveBeenCalled();
 const result={type:'compare',result:{validSymbols:[],invalidSymbols:[]}};
 worker.onmessage!({data:{id:worker.tasks[1].id,result}});
 await expect(second).resolves.toEqual(result);
 expect(vi.getTimerCount()).toBe(0);
});
