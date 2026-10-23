import { afterEach, expect, it, vi } from 'vitest';
import { gzipSync } from 'node:zlib';
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
it('derives sorted choices from the same cached revision, without duplicates or empty values', async () => {
 const data = {...snapshot, stocks:snapshot.stocks.map((stock, index) => ({...stock,
   sector:index ? ' Technology ' : 'technology', industry:'Software',
   indexMemberships:index ? ['Nifty 50','NIFTY 500'] : ['nifty 50',''],
 }))};
 const loader=vi.fn(async()=>data), run=createSnapshotEngine(loader);
 await run({type:'screen',source,request});
 const choices=await run({type:'filterChoices',source});
 expect(loader).toHaveBeenCalledTimes(1);
 expect(choices).toEqual({type:'filterChoices', result:{SECTOR:['Technology'],INDUSTRY:['Software'],
   SERIES:['EQ'],PRICE_BAND:['20'],INDEX_MEMBERSHIP:['Nifty 50','NIFTY 500']}});
 const changed=await run({type:'filterChoices',source:{...source,revision:'b'.repeat(64)}});
 expect(changed.type).toBe('filterChoices');
 expect(loader).toHaveBeenCalledTimes(2);
});
it('preserves historical classifications instead of rewriting a loaded revision', async () => {
 const data:Snapshot = {...snapshot,stocks:[
   {...snapshot.stocks[0],symbol:'AARTIDRUGS',sector:'Healthcare'},
   {...snapshot.stocks[1],symbol:'AARTIPHARM',sector:'Consumer Goods'},
 ]};
 data.totalStocks = data.stocks.length;
 const run=createSnapshotEngine(async()=>data);
 const result=await run({type:'filterChoices',source});
 expect(result).toEqual({type:'filterChoices',result:{
   SECTOR:['Consumer Goods','Healthcare'],INDUSTRY:['Test'],SERIES:['EQ'],PRICE_BAND:['20'],INDEX_MEMBERSHIP:[],
 }});
 expect(data.stocks[0].sector).toBe('Healthcare');
});
it('uses published classifications and secondary niche tags without changing them', async () => {
 const data:Snapshot = {...snapshot,stocks:[
   {...snapshot.stocks[0],symbol:'AUGMONT',sector:'Bullion & Precious Metals',
     industry:'Bullion Platform, Refining & Precious Metals',nicheTags:['Jewellery & Watches']},
 ]};
 data.totalStocks = data.stocks.length;
 const run=createSnapshotEngine(async()=>data);
 const result=await run({type:'compare',source,symbols:['AUGMONT']});
 expect(result).toMatchObject({type:'compare',result:{validSymbols:[{
   sector:'Bullion & Precious Metals',industry:'Bullion Platform, Refining & Precious Metals',nicheTags:['Jewellery & Watches'],
 }]}});
});
it('loads a revision once for concurrent screen and comparison tasks',async()=>{
 const loader=vi.fn(async()=>snapshot),run=createSnapshotEngine(loader);
 const [page,comparison]=await Promise.all([
  run({type:'screen',source,request}),run({type:'compare',source,symbols:[snapshot.stocks[0].symbol,'NOT_A_STOCK']})]);
 expect(loader).toHaveBeenCalledTimes(1);
 expect(page.type).toBe('screen');
 if(comparison.type==='compare') expect(comparison.result.invalidSymbols).toEqual(['NOT_A_STOCK']);
});
it('shares a pending startup warm-up with the first screen, and retries failed warm-ups', async () => {
 let resolve!: (data:Snapshot) => void;
 const loader = vi.fn().mockRejectedValueOnce(new Error('offline'))
   .mockImplementationOnce(() => new Promise<Snapshot>(done => { resolve = done; }));
 const run = createSnapshotEngine(loader);
 await expect(run({type:'warm',source})).rejects.toThrow('offline');
 const warm = run({type:'warm',source});
 const screen = run({type:'screen',source,request});
 expect(loader).toHaveBeenCalledTimes(2);
 resolve(snapshot);
 await expect(warm).resolves.toEqual({type:'warm'});
 await expect(screen).resolves.toMatchObject({type:'screen',result:{matchCount:60}});
 await run({type:'screen',source,request:{...request,page:2}});
 expect(loader).toHaveBeenCalledTimes(2);
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
 const {runSnapshotTask,startSnapshotWorker}=await import('../api/snapshotClient');
 startSnapshotWorker();
 expect(TestWorker.last.tasks).toHaveLength(0);
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
it.each(['missing','blocked'])('skips main-thread warm-up when workers are %s but retains scan fallback', async mode => {
 vi.useFakeTimers();
 const constructor = vi.fn(function(){throw new Error('CSP blocked');});
 vi.stubGlobal('Worker',mode === 'missing' ? undefined : constructor);
 const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(snapshot)));
 vi.stubGlobal('fetch',fetcher);
 const {runSnapshotTask} = await import('../api/snapshotClient');
 await expect(runSnapshotTask({type:'warm',source})).resolves.toEqual({type:'warm'});
 expect(fetcher).not.toHaveBeenCalled();
 expect(vi.getTimerCount()).toBe(0);
 await expect(runSnapshotTask({type:'screen',source,request})).resolves.toMatchObject({type:'screen',result:{matchCount:60}});
 expect(fetcher).toHaveBeenCalledTimes(1);
 expect(constructor).toHaveBeenCalledTimes(mode === 'blocked' ? 1 : 0);
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
it('aborts the fallback fetch when its task times out', async () => {
 vi.useFakeTimers();
 vi.stubGlobal('Worker', undefined);
 let fetchSignal: AbortSignal | undefined;
 vi.stubGlobal('fetch', vi.fn((_url, options?: RequestInit) => {
  fetchSignal = options?.signal ?? undefined;
  return new Promise<Response>((_resolve, reject) => {
   fetchSignal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  });
 }));
 const { runSnapshotTask } = await import('../api/snapshotClient');
 const task = runSnapshotTask({ type: 'screen', source, request });
 const failure = expect(task).rejects.toThrow('timed out');
 await vi.waitFor(() => expect(fetchSignal).toBeDefined());
 await vi.advanceTimersByTimeAsync(60000);
 await failure;
 expect(fetchSignal?.aborted).toBe(true);
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
 expect(worker.tasks).toContainEqual({ type: 'cancel', id: worker.tasks[0].id });
 const result={type:'compare',result:{validSymbols:[],invalidSymbols:[]}};
 worker.onmessage!({data:{id:worker.tasks[1].id,result}});
 await expect(second).resolves.toEqual(result);
 expect(vi.getTimerCount()).toBe(0);
});

it('isolates cancellation between tasks sharing a concurrent snapshot load', async () => {
 let resolveLoader!: (data: Snapshot) => void;
 let loaderSignal: AbortSignal | undefined;
 const loader = vi.fn((_source, signal?: AbortSignal) => {
  loaderSignal = signal;
  return new Promise<Snapshot>((resolve, reject) => {
   resolveLoader = resolve;
   signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  });
 });

 const run = createSnapshotEngine(loader);
 const ac1 = new AbortController();
 const ac2 = new AbortController();

 const task1 = run({ type: 'screen', source, request }, ac1.signal);
 const task2 = run({ type: 'screen', source, request: { ...request, page: 2 } }, ac2.signal);

 expect(loader).toHaveBeenCalledTimes(1);

 // Cancel task1
 ac1.abort();
 await expect(task1).rejects.toThrow('Aborted');

 // The shared fetch must NOT be aborted because task2 is still awaiting it
 expect(loaderSignal?.aborted).toBe(false);

 // Resolve the underlying fetch
 resolveLoader(snapshot);

 // Verify task2 succeeds
 const res2 = await task2;
 expect(res2.type).toBe('screen');
});

it('aborts the underlying shared fetch only when all subscribers cancel', async () => {
 let loaderSignal: AbortSignal | undefined;
 const loader = vi.fn((_source, signal?: AbortSignal) => {
  loaderSignal = signal;
  return new Promise<Snapshot>((_resolve, reject) => {
   signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  });
 });

 const run = createSnapshotEngine(loader);
 const ac1 = new AbortController();
 const ac2 = new AbortController();

 const task1 = run({ type: 'screen', source, request }, ac1.signal);
 const task2 = run({ type: 'screen', source, request: { ...request, page: 2 } }, ac2.signal);

 expect(loader).toHaveBeenCalledTimes(1);

 // Cancel task1
 ac1.abort();
 await expect(task1).rejects.toThrow('Aborted');
 expect(loaderSignal?.aborted).toBe(false);

 // Cancel task2
 ac2.abort();
 await expect(task2).rejects.toThrow('Aborted');

 // Now that all subscribers cancelled, loaderSignal MUST be aborted
 expect(loaderSignal?.aborted).toBe(true);
});

it('sends cancel message and cleans up abort listeners when a worker task times out', async () => {
 vi.useFakeTimers();
 class TestWorker {
  static last: TestWorker;
  onmessage?: (event: any) => void;
  tasks: any[] = [];
  terminate = vi.fn();
  constructor() { TestWorker.last = this; }
  postMessage(message: any) { this.tasks.push(message); }
 }
 vi.stubGlobal('Worker', TestWorker);
 const { runSnapshotTask } = await import('../api/snapshotClient');

 const ac = new AbortController();
 const taskPromise = runSnapshotTask({ type: 'screen', source, request }, ac.signal);
 const failure = expect(taskPromise).rejects.toThrow('timed out');

 await vi.advanceTimersByTimeAsync(60000);
 await failure;

 const worker = TestWorker.last;
 expect(worker.tasks).toContainEqual({ type: 'cancel', id: 1 });

 // Verify aborting ac.signal after timeout does not cause duplicate cancel messages
 const cancelMessagesBefore = worker.tasks.filter(t => t.type === 'cancel').length;
 ac.abort();
 const cancelMessagesAfter = worker.tasks.filter(t => t.type === 'cancel').length;
 expect(cancelMessagesAfter).toBe(cancelMessagesBefore);
});

it.each(['compressed', 'decompressed'])('screens packed gzip with %s HTTP delivery identically', async delivery => {
 const {stocks, ...metadata} = snapshot;
 const keys = Object.keys(stocks[0]);
 const packed = {...metadata, stockEncoding:'columnar-v1', nestedTables:{},
  stocksTable:{keys, values:stocks.map(stock => keys.map(key => (stock as any)[key])), missing:stocks.map(() => [])}};
 const json = JSON.stringify(packed);
 vi.stubGlobal('DecompressionStream',(await import('node:stream/web')).DecompressionStream);
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue(delivery === 'compressed'
  ? new Response(gzipSync(json)) : new Response(json, {headers:{'Content-Encoding':'gzip'}})));
 const packedResult = await createSnapshotEngine()({type:'screen',source:{...source,url:'/stocks.packed.json.gz'},request});
 const originalResult = await createSnapshotEngine(async () => snapshot)({type:'screen',source,request});
 expect(packedResult).toStrictEqual(originalResult);
});


it('shares old-release financial history loads and returns only the requested symbol', async () => {
 const fetch=vi.fn().mockResolvedValue(new Response(JSON.stringify({TEST:{observed_on:'2026-10-22'}}),{headers:{'Content-Encoding':'gzip'}}));
 vi.stubGlobal('fetch',fetch);
 const run=createSnapshotEngine(), historySource={...source,url:'/financial-history.json.gz'};
 expect(await run({type:'financialHistory',source:historySource,symbol:'TEST'})).toEqual({type:'financialHistory',result:{observed_on:'2026-10-22'}});
 expect(await run({type:'financialHistory',source:historySource,symbol:'OTHER'})).toEqual({type:'financialHistory',result:null});
 expect(fetch).toHaveBeenCalledTimes(1);
});
