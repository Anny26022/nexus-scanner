import { SCANNER_IDENTITY, assertScannerIdentity } from '../../../frontend/src/engine/compatibility';
import type { ScreenerRunRequest, ScreenerRunResponse } from '../../../frontend/src/types/screener';
import type { SnapshotStock } from '../../../frontend/src/api/snapshotScreen';
import { evaluateExpression, expressionDepth, negate, walkExpression, type EngineCondition, type EngineExpression, type Truth } from '../../../frontend/src/engine/expression';
import { evaluateHistoryCondition, type AdvancedContext, type CandleSeries } from '../../../frontend/src/engine/historyEngine';
import { detailedSelectedBases, publicSelectedBases } from '../../../frontend/src/engine/baseConditions';
import { compileTextQuery } from '../../../frontend/src/engine/queryCompiler';
import { PRESET_CATALOG } from '../../../frontend/src/data/presetCatalog';
import { NEXUS_CONDITION_CATALOG } from '../../../frontend/src/data/conditionCatalog';

interface Env { SCANNER_DATA:R2Bucket; ALLOWED_ORIGINS:string; SCANNER_RELEASE_URL:string }
interface PrivateManifest {schemaVersion:number;engineVersion:string;conditionContractHash:string;revision:string;session:string;symbols:number;shards:number;maxSessions:number;limits:{maxLeaves:number;maxDepth:number;maxPageSize:number;maxRequestBytes:number};objects:Array<{key:string;bytes:number;sha256:string;symbols?:number}>}
interface Metadata {stocks:SnapshotStock[]}
interface Auxiliary {turnover?:Record<string,NonNullable<AdvancedContext['turnover']>>;stocks?:Record<string,SnapshotStock>;bases?:Record<string,import('../../../frontend/src/engine/baseConditions').BaseRecord[]>;delivery:Record<string,NonNullable<AdvancedContext['delivery']>>;earnings:Record<string,Array<Record<string,unknown>>>;breadth?:Record<string,Record<string,number|null>>}

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
function responseWithCors(response:Response,headers:Record<string,string>){const merged=new Headers(response.headers);merged.delete('Access-Control-Allow-Origin');merged.delete('Access-Control-Allow-Headers');merged.delete('Access-Control-Allow-Methods');merged.delete('Vary');for(const [key,value] of Object.entries(headers))merged.set(key,value);return new Response(response.body,{status:response.status,headers:merged});}
function stable(value:unknown):string{if(Array.isArray(value))return `[${value.map(stable).join(',')}]`;if(value&&typeof value==='object')return `{${Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${JSON.stringify(k)}:${stable(v)}`).join(',')}}`;return JSON.stringify(value);}
async function hash(value:string){const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value));return [...new Uint8Array(digest)].map(v=>v.toString(16).padStart(2,'0')).join('');}
function releaseOwnedBuffer(buffer:ArrayBuffer){
  // These buffers are local to one object/stock. Release backing storage after
  // consumption rather than waiting for GC between successive cold scans.
  (buffer as ArrayBuffer&{transfer?:(length:number)=>ArrayBuffer}).transfer?.(0);
}
async function ungzip(bytes:ArrayBuffer){
  // Blob construction copies the compressed buffer. Feed its immutable view
  // directly so repeated scans do not allocate an extra copy of each object.
  const stream=new ReadableStream<BufferSource>({start(controller){controller.enqueue(new Uint8Array(bytes));controller.close();}});
  try{return await new Response(stream.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();}
  finally{releaseOwnedBuffer(bytes);}
}
async function objectBytes(env:Env,key:string,expected?:{bytes:number;sha256:string}){const object=await env.SCANNER_DATA.get(key);if(!object)throw new Error(`Advanced scanner object is unavailable: ${key}`);const bytes=await object.arrayBuffer();if(expected){const digest=await crypto.subtle.digest('SHA-256',bytes),hex=[...new Uint8Array(digest)].map(v=>v.toString(16).padStart(2,'0')).join('');if(bytes.byteLength!==expected.bytes||hex!==expected.sha256)throw new Error(`Advanced scanner checksum mismatch: ${key}`);}return bytes;}
async function compressedJson<T>(env:Env,prefix:string,manifest:PrivateManifest,name:string):Promise<T>{const descriptor=manifest.objects.find(x=>x.key===name);if(!descriptor)throw new Error(`Advanced scanner manifest is incomplete: ${name}`);const bytes=await ungzip(await objectBytes(env,`${prefix}/${name}`,descriptor));try{return JSON.parse(new TextDecoder().decode(bytes));}finally{releaseOwnedBuffer(bytes);}}

function* decodeShard(buffer:ArrayBuffer):Generator<{symbol:string;series:CandleSeries}>{
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
function universeRows(rows:SnapshotStock[],request:ScreenerRunRequest){const labels:Record<string,string[]>= {nifty50:['NIFTY 50','NIFTY50'],nifty500:['NIFTY 500','NIFTY500'],midsmall400:['NIFTY MIDSMALLCAP 400','NIFTY MIDSMALL 400','MIDSMALL400']},custom=new Set(request.customSymbols?.map(v=>v.toUpperCase()));return rows.filter(row=>request.universe==='mainboard'||request.universe==='custom'?request.universe==='mainboard'||custom.has(row.symbol):((row as unknown as {indexMemberships?:string[]}).indexMemberships??[]).some(label=>labels[request.universe]?.includes(label.toUpperCase())));}
export function executionWarnings(leaves:EngineCondition[],missingHistory:number){const warnings:string[]=[];if(leaves.some(condition=>condition.conditionId==='INSIDE_BAR'&&String(condition.parameters.timeframe).toUpperCase()==='WEEKLY'&&String(condition.parameters.weeklyMode).toUpperCase()==='CURRENT'))warnings.push('Weekly inside-bar current mode includes a provisional week.');if(missingHistory)warnings.push(`${missingHistory} equities have no aligned history in this revision.`);return warnings;}

async function currentRelease(env:Env){const response=await fetch(env.SCANNER_RELEASE_URL,{cf:{cacheTtl:30,cacheEverything:true}});if(!response.ok)throw new Error('Active scanner release is unavailable');const active=await response.json() as {revision:string;sessionDate:string;schemaVersion:number};if(active.schemaVersion===7)assertScannerIdentity(active);return active;}
async function run(request:ScreenerRunRequest,env:Env):Promise<ScreenerRunResponse>{assertScannerIdentity(request);const active=await currentRelease(env);if(active.schemaVersion!==7||request.datasetRevision!==active.revision||request.asOfDate!==active.sessionDate)throw new Error('Scanner revision is stale or incompatible. Refresh and run again.');const prefix=`scanner/v1/revisions/${active.revision}`,manifestObject=await env.SCANNER_DATA.get(`${prefix}/manifest.json`);if(!manifestObject)throw new Error('Advanced scanner revision is not fully published.');const manifest=await manifestObject.json<PrivateManifest>();assertScannerIdentity(manifest);if(manifest.revision!==active.revision||manifest.session!==active.sessionDate||manifest.schemaVersion!==7||manifest.shards!==32)throw new Error('Advanced scanner manifest is incompatible.');const expression=(request.textQuery?.trim()?compileTextQuery(request.textQuery):request.expressionTree) as EngineExpression;if(!expression||typeof expression!=='object')throw new Error('A valid screen expression is required.');const leaves=walkExpression(expression);if(!leaves.length)throw new Error('At least one condition is required.');if(leaves.length>manifest.limits.maxLeaves||expressionDepth(expression)>manifest.limits.maxDepth)throw new Error('Screen is too complex. Use at most 32 conditions and 8 nested levels.');validateExpression(expression);if(!Number.isInteger(request.page)||request.page<1||!Number.isInteger(request.pageSize)||request.pageSize<1||request.pageSize>manifest.limits.maxPageSize)throw new Error('Page and page size must be positive integers; page size cannot exceed 100.');const [metadata,benchmarks]=await Promise.all([compressedJson<Metadata>(env,prefix,manifest,'metadata.json.gz'),compressedJson<AdvancedContext['benchmarks']>(env,prefix,manifest,'benchmarks.json.gz')]),eligible=universeRows(metadata.stocks,request),bySymbol=new Map(eligible.map(row=>[row.symbol,row])),matched:Array<{symbol:string;sortValue:unknown;auxiliaryName?:string}>=[],seen=new Set<string>();let sharedBreadth:Auxiliary['breadth'];
  const sort=request.sort??{field:'symbol',direction:'asc'};
  const recordMatch=(stock:SnapshotStock,auxiliaryName?:string)=>matched.push({symbol:stock.symbol,sortValue:(stock as unknown as Record<string,unknown>)[sort.field],auxiliaryName});
  const coverage=leaves.map((condition,index)=>({key:condition.instanceId??`${condition.conditionId}:${index}`,conditionId:condition.conditionId,evaluated:0,matched:0,unavailable:0}));
  const account=(values:Map<EngineCondition,Truth>)=>leaves.forEach((condition,index)=>{const raw=values.get(condition)??null,value=condition.isNegated?negate(raw):raw;if(value===null)coverage[index].unavailable+=1;else{coverage[index].evaluated+=1;if(value)coverage[index].matched+=1;}});
  // A single active shard keeps decoded history bounded alongside metadata.
  for(let batch=0;batch<manifest.shards;batch+=1){const decoded=await Promise.all(Array.from({length:Math.min(1,manifest.shards-batch)},async(_,offset)=>{const index=String(batch+offset).padStart(2,'0'),name=`shards/${index}.bin.gz`,auxiliaryName=`auxiliary/${index}.json.gz`,descriptor=manifest.objects.find(x=>x.key===name);if(!descriptor)throw new Error(`Missing shard ${name}`);const [history,auxiliary]=await Promise.all([ungzip(await objectBytes(env,`${prefix}/${name}`,descriptor)).then(decodeShard),compressedJson<Auxiliary>(env,prefix,manifest,auxiliaryName)]);return {history,auxiliary,auxiliaryName};}));for(const shard of decoded){sharedBreadth??=shard.auxiliary.breadth;for(const {symbol,series} of shard.history){const indexed=bySymbol.get(symbol);if(!indexed)continue;const stock={...indexed,...shard.auxiliary.stocks?.[symbol]};seen.add(symbol);const context:AdvancedContext={stock,session:manifest.session,benchmarks,delivery:shard.auxiliary.delivery[symbol],turnover:shard.auxiliary.turnover?.[symbol],earnings:shard.auxiliary.earnings[symbol],breadth:shard.auxiliary.breadth,bases:shard.auxiliary.bases?.[symbol]},values=new Map<EngineCondition,Truth>();for(const condition of leaves)values.set(condition,evaluateHistoryCondition(series,{...condition,isNegated:false} as any,context));account(values);if(evaluateExpression(expression,condition=>values.get(condition)??null)===true)recordMatch(stock,shard.auxiliaryName);}}}
  const missing=eligible.filter(stock=>!seen.has(stock.symbol)),empty:CandleSeries={dates:new Int32Array(),open:new Float64Array(),high:new Float64Array(),low:new Float64Array(),close:new Float64Array(),volume:new Float64Array()};
  for(const stock of missing){const context:AdvancedContext={stock,session:manifest.session,benchmarks,breadth:sharedBreadth},values=new Map<EngineCondition,Truth>();for(const condition of leaves)values.set(condition,evaluateHistoryCondition(empty,{...condition,isNegated:false} as any,context));account(values);if(evaluateExpression(expression,condition=>values.get(condition)??null)===true)recordMatch(stock);}
  const missingHistory=missing.length,direction=sort.direction==='desc'?-1:1;matched.sort((a,b)=>{const x=a.sortValue as string|number|null|undefined,y=b.sortValue as string|number|null|undefined;if(x==null||y==null)return x==null&&y==null?0:x==null?1:-1;return (x<y?-1:x>y?1:0)*direction;});const page=request.page,size=request.pageSize,pageMatches=matched.slice((page-1)*size,page*size),pageRows=new Map<string,SnapshotStock>();
  // Retain only ranking keys across shards. Loading complete rows before
  // pagination retains the entire native dataset and its base contexts.
  for(const auxiliaryName of new Set(pageMatches.map(item=>item.auxiliaryName))){
    const auxiliary=auxiliaryName?await compressedJson<Auxiliary>(env,prefix,manifest,auxiliaryName):undefined;
    for(const item of pageMatches.filter(candidate=>candidate.auxiliaryName===auxiliaryName)){
      const stock={...bySymbol.get(item.symbol)!,...auxiliary?.stocks?.[item.symbol]};
      pageRows.set(item.symbol,{...stock,bases:publicSelectedBases(detailedSelectedBases(stock.bases,auxiliary?.bases?.[item.symbol]))});
    }
  }
  const perConditionCoverage=Object.fromEntries(coverage.map(item=>[item.key,{conditionId:item.conditionId,evaluated:item.evaluated,matched:item.matched,coveragePct:eligible.length?Math.round(item.evaluated/eligible.length*10000)/100:0}])),unavailableDiagnostics=coverage.filter(item=>item.unavailable).map(item=>({conditionId:item.conditionId,reason:'required advanced data unavailable',affectedCount:item.unavailable}));return {resolvedSession:{date:manifest.session,sessionId:`NSE-${manifest.session.replaceAll('-','')}-FINAL`,status:'closed',isHistorical:false},immutableRevision:manifest.revision,rows:pageMatches.map(item=>pageRows.get(item.symbol)!),matchCount:matched.length,totalUniverseCount:eligible.length,page,pageSize:size,perConditionCoverage,unavailableDiagnostics,warnings:executionWarnings(leaves,missingHistory)};}

export default {async fetch(request:Request,env:Env,ctx:ExecutionContext){const origin=request.headers.get('origin'),headers=cors(origin,env);if(request.method==='OPTIONS')return new Response(null,{status:204,headers});const url=new URL(request.url);if(url.pathname==='/v1/health'&&request.method==='GET'){try{const active=await currentRelease(env),object=await env.SCANNER_DATA.get(`scanner/v1/revisions/${active.revision}/manifest.json`);let ready=false;if(object){const marker=await object.json<PrivateManifest>();assertScannerIdentity(marker);ready=active.schemaVersion===7&&marker.schemaVersion===7&&marker.revision===active.revision&&marker.session===active.sessionDate;}return json({ok:ready,ready,revision:active.revision,session:active.sessionDate,...SCANNER_IDENTITY},ready?200:503,headers);}catch(error){return json({ok:false,error:error instanceof Error?error.message:'Unavailable'},503,headers);}}if(url.pathname!=='/v1/screens/run'||request.method!=='POST')return json({error:'Not found'},404,headers);const length=Number(request.headers.get('content-length')??0);if(length>100000)return json({error:'Request exceeds 100 KB'},413,headers);try{const text=await request.text();if(new TextEncoder().encode(text).byteLength>100000)throw new Error('Request exceeds 100 KB');const payload=JSON.parse(text) as ScreenerRunRequest,active=await currentRelease(env);if(active.schemaVersion!==7||payload.datasetRevision!==active.revision||payload.asOfDate!==active.sessionDate)throw new Error('Scanner revision is stale or incompatible. Refresh and run again.');assertScannerIdentity(payload);const key=await hash(stable([SCANNER_IDENTITY,payload.datasetRevision,payload.expressionTree,payload.textQuery,payload.universe,payload.customSymbols,payload.sort,payload.page,payload.pageSize])),cacheKey=new Request(`https://scanner-cache.invalid/v1/${key}`,{method:'GET'}),cache=(caches as CacheStorage&{default:Cache}).default,cached=await cache.match(cacheKey);if(cached)return responseWithCors(cached,headers);const response=json(await serializeScan(()=>run(payload,env)),200,{'Cache-Control':'public,max-age=2592000,immutable'});ctx.waitUntil(cache.put(cacheKey,response.clone()));return responseWithCors(response,headers);}catch(error){return json({error:error instanceof Error?error.message:'Advanced scanner failed'},error instanceof ScannerBusyError?503:400,headers);}}};
