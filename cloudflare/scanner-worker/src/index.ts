import { SCANNER_IDENTITY, assertScannerIdentity } from '../../../frontend/src/engine/compatibility';
import type { ScreenerRunRequest, ScreenerRunResponse } from '../../../frontend/src/types/screener';
import type { SnapshotStock } from '../../../frontend/src/api/snapshotScreen';
import { evaluateExpression, expressionDepth, negate, walkExpression, type EngineCondition, type EngineExpression, type Truth } from '../../../frontend/src/engine/expression';
import { evaluateHistoryCondition, type AdvancedContext, type CandleSeries } from '../../../frontend/src/engine/historyEngine';
import { publicSetupMatch, detailedSelectedBases, publicSelectedBases, evaluateBaseCondition } from '../../../frontend/src/engine/baseConditions';
import { compileTextQuery } from '../../../frontend/src/engine/queryCompiler';
import definitions from '../../../frontend/src/data/presetDefinitions.json';
import { materializeBasePreset } from '../../../frontend/src/engine/basePresets';
import { PRESET_CATALOG } from '../../../frontend/src/data/presetCatalog';
import { createCoverage } from '../../../frontend/src/engine/coverage';
import { conditionCapability } from '../../../frontend/src/api/capabilityRegistry';
import { NEXUS_CONDITION_CATALOG } from '../../../frontend/src/data/conditionCatalog';

interface Env { SCANNER_DATA:R2Bucket; ALLOWED_ORIGINS:string; SCANNER_RELEASE_URL:string }
interface PrivateManifest {schemaVersion:number;engineVersion:string;conditionContractHash:string;revision:string;session:string;symbols:number;shards:number;maxSessions:number;limits:{maxLeaves:number;maxDepth:number;maxPageSize:number;maxRequestBytes:number};objects:Array<{key:string;bytes:number;sha256:string;symbols?:number}>}
interface Metadata {stocks:SnapshotStock[];nativeRowsInAuxiliary?:boolean}
interface Auxiliary {setupCandidates?:Record<string,import('../../../frontend/src/engine/baseConditions').BaseRecord[]>;setupCandidateHistoryComplete?:Record<string,boolean>;turnover?:Record<string,NonNullable<AdvancedContext['turnover']>>;stocks?:Record<string,SnapshotStock>;bases?:Record<string,import('../../../frontend/src/engine/baseConditions').BaseRecord[]>;delivery:Record<string,NonNullable<AdvancedContext['delivery']>>;earnings:Record<string,Array<Record<string,unknown>>>;breadth?:Record<string,Record<string,number|null>>}

class ScannerBusyError extends Error {}
let scanTail:Promise<void>=Promise.resolve(),pendingScans=0;
/** Bound cold-scan memory across concurrent requests sharing an isolate. */
export async function serializeScan<T>(task:()=>Promise<T>):Promise<T>{
  if(pendingScans>=8)throw new ScannerBusyError('Advanced scanner is busy. Try again shortly.');
  pendingScans++;
  const previous=scanTail;let release!:()=>void;
  scanTail=new Promise<void>(resolve=>{release=resolve;});
  await previous;
  try{return await task();}finally{pendingScans--;release();}
}

const conditionDefinitions=new Map([...NEXUS_CONDITION_CATALOG,...PRESET_CATALOG].map(definition=>[definition.id,definition]));
const internalConditions=new Set(['FIELD_COMPARISON','DELIVERY_PERCENT']);

export function validateExpression(expression:EngineExpression){
  const validateNode=(node:EngineExpression):void=>{if(node.type==='group'){if(!['all','any'].includes(node.operator)||!node.children.length)throw new Error('Expression groups require a valid operator and at least one child.');node.children.forEach(validateNode);}};
  validateNode(expression);
  for(const condition of walkExpression(expression)){
    if(internalConditions.has(condition.conditionId))continue;
    const definition=conditionDefinitions.get(condition.conditionId);
    if(!definition)throw new Error(`Unsupported condition: ${condition.conditionId}`);
    if(condition.conditionId==='BASE_FORMULA' && condition.parameters.formula)evaluateBaseCondition(undefined,condition as import('../../../frontend/src/types/screener').ActiveCondition);
    const preset=definitions.find(item=>item.id===condition.conditionId&&'setupFamily' in item);
    if(preset)materializeBasePreset(preset,condition.parameters);
    const specifications=new Map(definition.parameters.map(parameter=>[parameter.id,parameter]));
    if(condition.conditionId==='MARKET_BREADTH' && String(condition.parameters.universe ?? 'ALL_ACTIVE').toUpperCase()!=='ALL_ACTIVE') throw new Error('Only ALL_ACTIVE market breadth is published in this release.');
    for(const [key,value] of Object.entries(condition.parameters)){
      const specification=specifications.get(key);
      if(!specification)throw new Error(`Unsupported parameter ${key} for ${condition.conditionId}`);
      if(specification.type==='number'){
        if(typeof value!=='number'||!Number.isFinite(value))throw new Error(`${condition.conditionId}.${key} must be a finite number`);
        if(specification.min!=null&&value<specification.min)throw new Error(`${condition.conditionId}.${key} is below its supported minimum`);
        if(specification.max!=null&&value>specification.max)throw new Error(`${condition.conditionId}.${key} exceeds its supported maximum`);
      }
      if(specification.type==='select'&&specification.options&&!specification.options.some(option=>option.value===value)
        && !(key==='comparison'&&['GREATER','LESS','EQUAL'].includes(String(value))))throw new Error(`${condition.conditionId}.${key} is unsupported`);
    }
  }
}

function cors(origin:string|null,env:Env):Record<string,string>{const allowed=new Set(env.ALLOWED_ORIGINS.split(',').map(v=>v.trim()).filter(Boolean));return origin&&allowed.has(origin)?{'Access-Control-Allow-Origin':origin,'Access-Control-Allow-Headers':'content-type','Access-Control-Allow-Methods':'POST,GET,OPTIONS','Vary':'Origin'}:{};}
function json(value:unknown,status=200,headers:HeadersInit={}){return new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json; charset=utf-8',...headers}});}
function stable(value:unknown):string{if(Array.isArray(value))return `[${value.map(stable).join(',')}]`;if(value&&typeof value==='object')return `{${Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${JSON.stringify(k)}:${stable(v)}`).join(',')}}`;return JSON.stringify(value);}
async function hash(value:string){const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value));return [...new Uint8Array(digest)].map(v=>v.toString(16).padStart(2,'0')).join('');}
function releaseOwnedBuffer(buffer:ArrayBuffer){
  // These buffers are local to one object/stock. Release backing storage after
  // consumption rather than waiting for GC between successive cold scans.
  (buffer as ArrayBuffer&{transfer?:(length:number)=>ArrayBuffer}).transfer?.(0);
}
export async function ungzip(bytes:ArrayBuffer,limit=80*1024*1024){
  // Blob construction copies the compressed buffer. Feed its immutable view
  // directly so repeated scans do not allocate an extra copy of each object.
  const stream=new ReadableStream<BufferSource>({start(controller){controller.enqueue(new Uint8Array(bytes));controller.close();}});
  const reader=stream.pipeThrough(new DecompressionStream('gzip')).getReader();
  try{const size=bytes.byteLength>=4?new DataView(bytes).getUint32(bytes.byteLength-4,true):limit+1;if(size>limit){await reader.cancel();throw new Error('Decoded scanner object exceeds its memory budget');}const output=new Uint8Array(size);let offset=0;while(true){const {done,value}=await reader.read();if(done)break;if(offset+value.byteLength>size){await reader.cancel();throw new Error('Decoded scanner size does not match gzip trailer');}output.set(value,offset);offset+=value.byteLength;}if(offset!==size)throw new Error('Decoded scanner size does not match gzip trailer');return output.buffer;}
  finally{releaseOwnedBuffer(bytes);}
}
async function objectBytes(env:Env,key:string,expected?:{bytes:number;sha256:string}){const object=await env.SCANNER_DATA.get(key);if(!object)throw new Error(`Advanced scanner object is unavailable: ${key}`);const bytes=await object.arrayBuffer();if(expected){const digest=await crypto.subtle.digest('SHA-256',bytes),hex=[...new Uint8Array(digest)].map(v=>v.toString(16).padStart(2,'0')).join('');if(bytes.byteLength!==expected.bytes||hex!==expected.sha256)throw new Error(`Advanced scanner checksum mismatch: ${key}`);}return bytes;}
async function compressedJson<T>(env:Env,prefix:string,manifest:PrivateManifest,name:string):Promise<T>{const descriptor=manifest.objects.find(x=>x.key===name);if(!descriptor)throw new Error(`Advanced scanner manifest is incomplete: ${name}`);const bytes=await ungzip(await objectBytes(env,`${prefix}/${name}`,descriptor),name.startsWith('auxiliary/')?12*1024*1024:24*1024*1024);try{return JSON.parse(new TextDecoder().decode(bytes));}finally{releaseOwnedBuffer(bytes);}}

export function* decodeShard(buffer:ArrayBuffer):Generator<{symbol:string;series:CandleSeries}>{
  const bytes=new Uint8Array(buffer),magic=new TextDecoder().decode(bytes.subarray(0,8));
  if(magic!=='NSPK0001')throw new Error('Invalid scanner shard');
  const headerLength=new DataView(buffer).getUint32(8,true);
  const header=JSON.parse(new TextDecoder().decode(bytes.subarray(12,12+headerLength))) as {symbols:Array<{symbol:string;offset:number;count:number}>};
  const count=header.symbols.reduce((total,item)=>Math.max(total,item.offset+item.count),0);
  const dateStart=(12+headerLength+7)&~7,valueStart=(dateStart+count*4+7)&~7;
  const dates=new Int32Array(buffer,dateStart,count),values=new Float64Array(buffer,valueStart,count*5);
  // Retain the shard buffer and materialize columns only for the stock being
  // evaluated. Eager decoding duplicates the complete batch's OHLCV arrays.
  try{for(const item of header.symbols){
    const matrix=values.subarray(item.offset*5,(item.offset+item.count)*5);
    const column=(index:number)=>Float64Array.from({length:item.count},(_,i)=>matrix[i*5+index]);
    const series={dates:dates.subarray(item.offset,item.offset+item.count),open:column(0),high:column(1),low:column(2),close:column(3),volume:column(4)};
    try{yield {symbol:item.symbol,series};}
    finally{for(const values of [series.open,series.high,series.low,series.close,series.volume])releaseOwnedBuffer(values.buffer);}
  }}finally{releaseOwnedBuffer(buffer);}
}
function universeRows(rows: SnapshotStock[], request: ScreenerRunRequest) {
  const labels: Record<string, string[]> = {
    nifty50: ['NIFTY 50', 'NIFTY50'],
    nifty500: ['NIFTY 500', 'NIFTY500'],
    midsmall400: ['NIFTY MIDSMALLCAP 400', 'NIFTY MIDSMALL 400', 'MIDSMALL400'],
  };
  const custom = new Set(request.customSymbols?.map(symbol => symbol.toUpperCase()));
  const announcements = request.announcementSymbols
    ? new Set(request.announcementSymbols.map(symbol => symbol.toUpperCase())) : null;
  return rows.filter(row => {
    if (announcements && !announcements.has(row.symbol)) return false;
    if (request.universe === 'mainboard') return true;
    if (request.universe === 'custom') return custom.has(row.symbol);
    return row.indexMemberships?.some(label => labels[request.universe]?.includes(label.toUpperCase()));
  });
}
export function executionWarnings(leaves:EngineCondition[],missingHistory:number){const warnings:string[]=[];if(leaves.some(condition=>condition.conditionId==='INSIDE_BAR'&&String(condition.parameters.timeframe).toUpperCase()==='WEEKLY'&&String(condition.parameters.weeklyMode).toUpperCase()==='CURRENT'))warnings.push('Weekly inside-bar current mode includes a provisional week.');if(missingHistory)warnings.push(`${missingHistory} equities have no aligned history in this revision.`);return warnings;}

async function currentRelease(env:Env){const response=await fetch(env.SCANNER_RELEASE_URL,{cf:{cacheTtl:30,cacheEverything:true}});if(!response.ok)throw new Error('Active scanner release is unavailable');const active=await response.json() as {revision:string;sessionDate:string;schemaVersion:number};if(active.schemaVersion===7)assertScannerIdentity(active);return active;}
// Bump when evaluation semantics change so unchanged data cannot reuse old results.
const CACHE_VERSION = '4';
type ScanResult = Omit<ScreenerRunResponse,'page' | 'pageSize'>;
const emptySeries:CandleSeries = {dates:new Int32Array(),open:new Float64Array(),high:new Float64Array(),
  low:new Float64Array(),close:new Float64Array(),volume:new Float64Array()};

function validateRequest(request:ScreenerRunRequest,expression:EngineExpression) {
  if (request.announcementSymbols !== undefined && (!Array.isArray(request.announcementSymbols)
      || request.announcementSymbols.some(symbol => typeof symbol !== 'string')))
    throw new Error('Announcement symbols must be an array of strings.');
  const leaves=walkExpression(expression);
  if(!leaves.length)throw new Error('At least one condition is required.');
  if(leaves.length>32 || expressionDepth(expression)>8)throw new Error('Screen is too complex. Use at most 32 conditions and 8 nested levels.');
  validateExpression(expression);
  if(!Number.isInteger(request.page) || request.page<1 || !Number.isInteger(request.pageSize) || request.pageSize<1 || request.pageSize>100)
    throw new Error('Page and page size must be positive integers; page size cannot exceed 100.');
}

async function selectedShards(symbols:string[],count:number):Promise<number[]> {
  const indices=await Promise.all(symbols.map(async symbol=>{
    const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(symbol));
    return new Uint8Array(digest)[0] % count;
  }));
  return [...new Set(indices)].sort((a,b)=>a-b);
}

async function run(request:ScreenerRunRequest,expression:EngineExpression,env:Env):Promise<ScanResult> {
  const prefix=`scanner/v1/revisions/${request.datasetRevision}`;
  const manifestObject=await env.SCANNER_DATA.get(`${prefix}/manifest.json`);
  if(!manifestObject)throw new Error('Advanced scanner revision is not fully published.');
  const manifest=await manifestObject.json<PrivateManifest>();
  assertScannerIdentity(manifest);
  if(manifest.revision!==request.datasetRevision || manifest.session!==request.asOfDate || manifest.schemaVersion!==7 || manifest.shards!==32)
    throw new Error('Advanced scanner manifest is incompatible.');
  const leaves=walkExpression(expression);
  const metadata=await compressedJson<Metadata>(env,prefix,manifest,'metadata.json.gz');
  const eligible=universeRows(metadata.stocks,request),bySymbol=new Map(eligible.map(row=>[row.symbol,row]));
  const matched:SnapshotStock[]=[],seen=new Set<string>(),coverage=createCoverage(leaves,eligible.length);
  const needsHistory=leaves.some(condition=>!conditionCapability(condition as any).browser(condition as any));
  const benchmarks=needsHistory && eligible.length
    ? await compressedJson<AdvancedContext['benchmarks']>(env,prefix,manifest,'benchmarks.json.gz') : undefined;
  let sharedBreadth:Auxiliary['breadth'];
  const evaluate=(stock:SnapshotStock,series:CandleSeries,auxiliary?:Auxiliary)=>{
    const context:AdvancedContext={stock,session:manifest.session,benchmarks,
      delivery:auxiliary?.delivery[stock.symbol],earnings:auxiliary?.earnings[stock.symbol],
      turnover:auxiliary?.turnover?.[stock.symbol], bases:auxiliary?.bases?.[stock.symbol],
      setupCandidates:auxiliary?.setupCandidates?.[stock.symbol],
      setupCandidateHistoryComplete:auxiliary?.setupCandidateHistoryComplete?.[stock.symbol],setupMatches:{},
      breadth:auxiliary?.breadth ?? sharedBreadth};
    const values=new Map(leaves.map(condition=>[condition,evaluateHistoryCondition(series,{...condition,isNegated:false} as any,context)]));
    coverage.account(leaves.map(condition=>condition.isNegated ? negate(values.get(condition)!) : values.get(condition)!));
    if(evaluateExpression(expression,condition=>values.get(condition) ?? null)===true && Number.isFinite(stock.close)){
      // Cache only public records, never retain private base candidates across shards.
      const {setupCandidates: _candidates, ...publicStock}=stock;
      const setupMatches=Object.fromEntries(Object.entries(context.setupMatches ?? {})
        .filter(([key])=>!leaves.some(condition=>condition.isNegated && (condition.instanceId ?? condition.conditionId)===key))
        .map(([key,record])=>[key,publicSetupMatch(record)]));
      matched.push({...publicStock,setupMatches,bases:publicSelectedBases(detailedSelectedBases(stock.bases,auxiliary?.bases?.[stock.symbol]))});
    }
  };
  if(needsHistory || metadata.nativeRowsInAuxiliary) {
    const indices=request.universe==='mainboard'
      ? Array.from({length:manifest.shards},(_,index)=>index)
      : await selectedShards(eligible.map(row=>row.symbol),manifest.shards);
    for(let batch=0;batch<indices.length;batch+=1) {
      const decoded=await Promise.all(indices.slice(batch,batch+1).map(async shard=>{
        const index=String(shard).padStart(2,'0'),name=`shards/${index}.bin.gz`;
        const descriptor=manifest.objects.find(object=>object.key===name);
        if(!descriptor)throw new Error(`Missing shard ${name}`);
        const [history,auxiliary]=await Promise.all([
          ungzip(await objectBytes(env,`${prefix}/${name}`,descriptor)).then(decodeShard),
          compressedJson<Auxiliary>(env,prefix,manifest,`auxiliary/${index}.json.gz`),
        ]);
        return {history,auxiliary};
      }));
      for(const shard of decoded) {
        sharedBreadth ??= shard.auxiliary.breadth;
        for(const {symbol,series} of shard.history) {
          const indexed=bySymbol.get(symbol);
          if(!indexed)continue;
          const stock={...indexed,...shard.auxiliary.stocks?.[symbol]};
          seen.add(symbol);evaluate(stock,series,shard.auxiliary);
        }
      }
    }
  }
  const missing=eligible.filter(stock=>!seen.has(stock.symbol));
  for(const stock of missing)evaluate(stock,emptySeries);
  return {
    resolvedSession:{date:manifest.session,sessionId:`NSE-${manifest.session.replaceAll('-','')}-FINAL`,status:'closed',isHistorical:false},
    immutableRevision:manifest.revision,rows:matched,matchCount:matched.length,totalUniverseCount:eligible.length,
    ...coverage.result(),warnings:executionWarnings(leaves,needsHistory ? missing.length : 0),
  };
}

function pageResult(result:ScanResult,request:ScreenerRunRequest):ScreenerRunResponse {
  const sort=request.sort ?? {field:'symbol',direction:'asc'},direction=sort.direction==='desc' ? -1 : 1;
  const rows=[...result.rows].sort((a,b)=>{
    const x=(a as any)[sort.field],y=(b as any)[sort.field];
    if(x==null || y==null)return x==null && y==null ? a.symbol.localeCompare(b.symbol) : x==null ? 1 : -1;
    return (x<y ? -1 : x>y ? 1 : a.symbol.localeCompare(b.symbol))*direction;
  });
  return {...result,rows:rows.slice((request.page-1)*request.pageSize,request.page*request.pageSize),
    page:request.page,pageSize:request.pageSize};
}

export default {
  async fetch(request:Request,env:Env,ctx:ExecutionContext) {
    const headers=cors(request.headers.get('origin'),env),url=new URL(request.url);
    if(request.method==='OPTIONS')return new Response(null,{status:204,headers});
    if(url.pathname==='/v1/health' && request.method==='GET') {
      try {
        const active=await currentRelease(env),object=await env.SCANNER_DATA.get(`scanner/v1/revisions/${active.revision}/manifest.json`);
        let ready=false;
        if(object) {
          const marker=await object.json<PrivateManifest>();
          assertScannerIdentity(marker);
          ready=active.schemaVersion===7 && marker.schemaVersion===7 && marker.revision===active.revision && marker.session===active.sessionDate;
        }
        return json({ok:ready,ready,revision:active.revision,session:active.sessionDate,...SCANNER_IDENTITY},ready ? 200 : 503,headers);
      } catch(error) { return json({ok:false,error:error instanceof Error ? error.message : 'Unavailable'},503,headers); }
    }
    if(url.pathname!=='/v1/screens/run' || request.method!=='POST')return json({error:'Not found'},404,headers);
    if(Number(request.headers.get('content-length') ?? 0)>100000)return json({error:'Request exceeds 100 KB'},413,headers);
    try {
      const text=await request.text();
      if(new TextEncoder().encode(text).byteLength>100000)throw new Error('Request exceeds 100 KB');
      const payload=JSON.parse(text) as ScreenerRunRequest,active=await currentRelease(env);
      if(active.schemaVersion!==7 || payload.datasetRevision!==active.revision || payload.asOfDate!==active.sessionDate)
        throw new Error('Scanner revision is stale or incompatible. Refresh and run again.');
      assertScannerIdentity(payload);
      const expression=(payload.textQuery?.trim() ? compileTextQuery(payload.textQuery) : payload.expressionTree) as EngineExpression;
      if(!expression || typeof expression!=='object')throw new Error('A valid screen expression is required.');
      validateRequest(payload,expression);
      // Cache the complete match set; sorting and pagination never change membership.
      const symbols=payload.universe==='custom' ? [...new Set(payload.customSymbols?.map(symbol=>symbol.toUpperCase()))].sort() : undefined;
      const announcements = payload.announcementSymbols === undefined ? undefined
        : [...new Set(payload.announcementSymbols.map(symbol => symbol.toUpperCase()))].sort();
      const key=await hash(stable([CACHE_VERSION,SCANNER_IDENTITY,payload.datasetRevision,payload.asOfDate,expression,payload.universe,symbols,announcements]));
      const cacheKey=new Request(`https://scanner-cache.invalid/v${CACHE_VERSION}/${key}`),cache=(caches as CacheStorage&{default:Cache}).default;
      const cached=await cache.match(cacheKey);
      let result:ScanResult;
      if(cached)result=await cached.json<ScanResult>();
      else {
        result=await serializeScan(()=>run(payload,expression,env));
        ctx.waitUntil(cache.put(cacheKey,json(result,200,{'Cache-Control':'public,max-age=2592000,immutable'})));
      }
      return json(pageResult(result,payload),200,headers);
    } catch(error) { return json({error:error instanceof Error ? error.message : 'Advanced scanner failed'},error instanceof ScannerBusyError ? 503 : 400,headers); }
  },
};
