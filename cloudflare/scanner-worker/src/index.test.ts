import {gzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import { afterEach,describe,expect,it,vi } from 'vitest';
import worker,{executionWarnings,validateExpression} from './index';
import { SCANNER_IDENTITY } from '../../../frontend/src/engine/compatibility';

afterEach(()=>vi.unstubAllGlobals());
const execution={waitUntil:vi.fn()} as unknown as ExecutionContext;
function environment(marker=true){const manifest={...SCANNER_IDENTITY,schemaVersion:7,revision:'a'.repeat(64),session:'2026-10-01'};return {ALLOWED_ORIGINS:'https://app.example,http://localhost:8080',SCANNER_RELEASE_URL:'https://app.example/data/current.json',SCANNER_DATA:{get:vi.fn(async()=>marker?{json:async()=>manifest}:null)} as unknown as R2Bucket};}

describe('scanner worker boundary',()=>{
  it('reports active revision health and applies allowlisted CORS',async()=>{
    vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({revision:'a'.repeat(64),sessionDate:'2026-10-01',schemaVersion:7,...SCANNER_IDENTITY}))));
    const response=await worker.fetch(new Request('https://worker.example/v1/health',{headers:{origin:'https://app.example'}}),environment(),execution);
    expect(response.status).toBe(200);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://app.example');
    expect(await response.json()).toMatchObject({ok:true,session:'2026-10-01'});
  });
  it('never reflects an unapproved origin',async()=>{
    vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({revision:'a'.repeat(64),sessionDate:'2026-10-01',schemaVersion:7,...SCANNER_IDENTITY}))));
    const response=await worker.fetch(new Request('https://worker.example/v1/health',{headers:{origin:'https://evil.example'}}),environment(),execution);
    expect(response.headers.has('Access-Control-Allow-Origin')).toBe(false);
  });
  it('does not report ready when the R2 marker revision differs from the active release',async()=>{
    vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({revision:'a'.repeat(64),sessionDate:'2026-10-01',schemaVersion:7,...SCANNER_IDENTITY}))));
    const env=environment() as any;env.SCANNER_DATA.get=vi.fn(async()=>({json:async()=>({...SCANNER_IDENTITY,schemaVersion:7,revision:'b'.repeat(64),session:'2026-10-01'})}));
    const response=await worker.fetch(new Request('https://worker.example/v1/health'),env,execution);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ok:false,ready:false});
  });
  it('does not report ready for an unreadable R2 marker',async()=>{
    vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({revision:'a'.repeat(64),sessionDate:'2026-10-01',schemaVersion:7,...SCANNER_IDENTITY}))));
    const env=environment() as any;env.SCANNER_DATA.get=vi.fn(async()=>({json:async()=>{throw new Error('invalid JSON')}}));
    const response=await worker.fetch(new Request('https://worker.example/v1/health'),env,execution);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ok:false});
  });
  it('rejects an incompatible active schema-7 release before an advanced scan',async()=>{
    vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({revision:'a'.repeat(64),sessionDate:'2026-10-01',schemaVersion:7,...SCANNER_IDENTITY,engineVersion:'old'}))));
    const response=await worker.fetch(new Request('https://worker.example/v1/screens/run',{method:'POST',body:JSON.stringify({...SCANNER_IDENTITY,datasetRevision:'a'.repeat(64),asOfDate:'2026-10-01'})}),environment(),execution);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({error:expect.stringContaining('incompatible')});
  });
  it('does not report ready for an incompatible active schema-7 release',async()=>{
    vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({revision:'a'.repeat(64),sessionDate:'2026-10-01',schemaVersion:7,...SCANNER_IDENTITY,engineVersion:'old'}))));
    const response=await worker.fetch(new Request('https://worker.example/v1/health'),environment(),execution);
    expect(response.status).toBe(503);
  });
  it('rejects an incompatible private manifest before reading any shard',async()=>{
    vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({revision:'a'.repeat(64),sessionDate:'2026-10-01',schemaVersion:7,...SCANNER_IDENTITY}))));
    const env=environment() as any;
    env.SCANNER_DATA.get=vi.fn(async()=>({json:async()=>({...SCANNER_IDENTITY,engineVersion:'old',schemaVersion:7,revision:'a'.repeat(64),session:'2026-10-01'})}));
    vi.stubGlobal('caches',{default:{match:vi.fn(async()=>undefined)}});
    const response=await worker.fetch(new Request('https://worker.example/v1/screens/run',{method:'POST',body:JSON.stringify({...SCANNER_IDENTITY,datasetRevision:'a'.repeat(64),asOfDate:'2026-10-01'})}),env,execution);
    expect(response.status).toBe(400);
    expect(env.SCANNER_DATA.get).toHaveBeenCalledTimes(1);
  });
  it.each(['engineVersion','conditionContractHash'])('rejects mismatched %s before consulting the response cache',async(field)=>{
    vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({revision:'a'.repeat(64),sessionDate:'2026-10-01',schemaVersion:7,...SCANNER_IDENTITY}))));
    const match=vi.fn();vi.stubGlobal('caches',{default:{match}});
    const payload={...SCANNER_IDENTITY,[field]:'old',datasetRevision:'a'.repeat(64),asOfDate:'2026-10-01'};
    const response=await worker.fetch(new Request('https://worker.example/v1/screens/run',{method:'POST',body:JSON.stringify(payload)}),environment(),execution);
    expect(response.status).toBe(400);expect(match).not.toHaveBeenCalled();
    expect(await response.json()).toMatchObject({error:expect.stringContaining('incompatible')});
  });
  it('rejects oversized requests before reading the body',async()=>{
    const request=new Request('https://worker.example/v1/screens/run',{method:'POST',headers:{'content-length':'100001'},body:'{}'});
    const response=await worker.fetch(request,environment(),execution);
    expect(response.status).toBe(413);
  });
  it('rejects unknown conditions and out-of-contract parameters',()=>{
    expect(()=>validateExpression({type:'condition',condition:{conditionId:'MADE_UP',parameters:{}}})).toThrow('Unsupported condition');
    expect(()=>validateExpression({type:'condition',condition:{conditionId:'ADX',parameters:{period:14,comparison:'SIDEWAYS',value:25}}})).toThrow('is unsupported');
    expect(()=>validateExpression({type:'condition',condition:{conditionId:'FIELD_COMPARISON',parameters:{field:'close',comparison:'GREATER',value:100}}})).not.toThrow();
  });
  it('marks current weekly inside bars as provisional in the response metadata',()=>{
    expect(executionWarnings([{conditionId:'INSIDE_BAR',parameters:{timeframe:'WEEKLY',weeklyMode:'CURRENT'}}] as any,0)).toEqual(['Weekly inside-bar current mode includes a provisional week.']);
    expect(executionWarnings([{conditionId:'INSIDE_BAR',parameters:{timeframe:'WEEKLY',weeklyMode:'COMPLETED'}}] as any,2)).toEqual(['2 equities have no aligned history in this revision.']);
  });
});
it('reports unhealthy when the private engine differs despite matching revision and session',async()=>{
  vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({...SCANNER_IDENTITY,revision:'a'.repeat(64),sessionDate:'2026-10-01',schemaVersion:7}))));
  const env=environment() as any;
  env.SCANNER_DATA.get=vi.fn(async()=>({json:async()=>({...SCANNER_IDENTITY,engineVersion:'old',schemaVersion:7,revision:'a'.repeat(64),session:'2026-10-01'})}));
  const response=await worker.fetch(new Request('https://worker.example/v1/health'),env,execution);
  expect(response.status).toBe(503);
});

it('runs a complete nested base preset and private metric through verified R2 shards',async()=>{
  const revision='a'.repeat(64),session='2026-10-01',objects=new Map<string,Buffer>();
  const base={id:'same-base',pivot:100,distanceFromPivotPct:-2,continuousHolding:true,holdsPivot:true,
    base:{ageSessions:40,depthPct:20,atrContraction:.6,volumeDryUp:.6},
    current:{medianTurnover20:10,distanceSMA200:10,slopeSMA200:1,rsRating:90,rsChange22:5,distanceClosing52wHigh:10}};
  const stock={symbol:'TEST',name:'Test',historyAligned:true,asOfDate:session,bases:{FORMING:base}};
  const save=(key:string,value:unknown)=>objects.set(key,gzipSync(Buffer.from(JSON.stringify(value))));
  save('metadata.json.gz',{stocks:[stock]});save('benchmarks.json.gz',{});
  for(let index=0;index<32;index++){
    const count=index===0?1:0,header=Buffer.from(JSON.stringify({symbols:count?[{symbol:'TEST',offset:0,count:1}]:[]}));
    const dates=(12+header.length+7)&~7,values=(dates+count*4+7)&~7,raw=Buffer.alloc(values+count*40);
    raw.write('NSPK0001');raw.writeUInt32LE(header.length,8);header.copy(raw,12);
    if(count){raw.writeInt32LE(Math.floor(Date.parse(session)/86400000),dates);[100,102,98,100,1000].forEach((n,i)=>raw.writeDoubleLE(n,values+i*8));}
    const suffix=String(index).padStart(2,'0');objects.set(`shards/${suffix}.bin.gz`,gzipSync(raw));
    save(`auxiliary/${suffix}.json.gz`,{delivery:{},earnings:{},bases:count?{TEST:[{...base,current:{...base.current,distanceEMA150:8}}]}:{}});
  }
  const manifest={...SCANNER_IDENTITY,schemaVersion:7,revision,session,shards:32,symbols:1,maxSessions:1500,
    limits:{maxLeaves:32,maxDepth:8,maxPageSize:100,maxRequestBytes:100000},objects:[...objects].map(([key,buffer])=>({key,bytes:buffer.length,sha256:createHash('sha256').update(buffer).digest('hex')}))};
  const get=vi.fn(async(key:string)=>{const name=key.replace(`scanner/v1/revisions/${revision}/`,'');if(name==='manifest.json')return {json:async()=>manifest};const buffer=objects.get(name);return buffer?{arrayBuffer:async()=>buffer.buffer.slice(buffer.byteOffset,buffer.byteOffset+buffer.byteLength)}:null;});
  const env={...environment(),SCANNER_DATA:{get} as unknown as R2Bucket};
  vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({...SCANNER_IDENTITY,revision,sessionDate:session,schemaVersion:7}))));
  const match=vi.fn(async()=>undefined),put=vi.fn(async()=>undefined);vi.stubGlobal('caches',{default:{match,put}});
  const leaf=(conditionId:string,parameters:Record<string,unknown>)=>({type:'condition',condition:{instanceId:conditionId,conditionId,parameters}});
  const payload={...SCANNER_IDENTITY,datasetRevision:revision,asOfDate:session,universe:'mainboard',page:1,pageSize:15,
    expressionTree:{type:'group',operator:'all',children:[leaf('lib-nexus-strong-bases',{}),{type:'group',operator:'any',children:[leaf('BASE_METRIC',{stage:'FORMING',metric:'current.distanceEMA150',comparison:'GREATER',value:7}),leaf('BASE_METRIC',{stage:'FORMING',metric:'base.depthPct',comparison:'LESS',value:10})]}]}};
  const request=()=>new Request('https://worker.example/v1/screens/run',{method:'POST',headers:{origin:'https://app.example'},body:JSON.stringify(payload)});
  const response=await worker.fetch(request(),env,execution);expect(response.status).toBe(200);
  const body=await response.clone().json() as any;expect(body.rows.map((row:any)=>row.symbol)).toEqual(['TEST']);expect(body.unavailableDiagnostics).toEqual([]);
  expect(get.mock.calls.some(([key])=>key.includes('base-history/'))).toBe(false);
  expect(put).toHaveBeenCalledOnce();const reads=get.mock.calls.length;
  match.mockImplementation(async()=>response.clone() as any);
  const cached=await worker.fetch(request(),env,execution);expect(cached.status).toBe(200);expect(get).toHaveBeenCalledTimes(reads);
});
