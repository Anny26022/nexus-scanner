/// <reference types="node" />
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import worker from './index';
const revision='a'.repeat(64),session='2026-10-01',prefix=`scanner/v1/revisions/${revision}`;
const shard=(symbol:string)=>createHash('sha256').update(symbol).digest()[0] % 32;
function binary(symbols:string[]) {
  const count=40,header=Buffer.from(JSON.stringify({symbols:symbols.map((symbol,index)=>({symbol,offset:index*count,count}))}));
  const dateStart=(12+header.length+7)&~7,valueStart=(dateStart+symbols.length*count*4+7)&~7;
  const raw=Buffer.alloc(valueStart+symbols.length*count*40);
  raw.write('NSPK0001');raw.writeUInt32LE(header.length,8);header.copy(raw,12);
  symbols.forEach((_,index)=>{for(let i=0;i<count;i++) {
    raw.writeInt32LE(Date.parse(session)/86400000-count+1+i,dateStart+(index*count+i)*4);
    [100+i,102+i,98+i,101+i,100000].forEach((value,column)=>raw.writeDoubleLE(value,valueStart+((index*count+i)*5+column)*8));
  }});
  return gzipSync(raw);
}
function fixture() {
  const stocks=['AAA','BBB','MISSING','STALE'].map(symbol=>({symbol,name:symbol,close:140,marketCapCrore:3000,
    metadataAsOfDate:symbol==='STALE' ? '2026-09-30' : session,asOfDate:session,historyAligned:true,indexMemberships:[],metrics:{sma50:120},presetMatches:{}}));
  const objects=new Map<string,Buffer>(),descriptors:Array<{key:string;bytes:number;sha256:string}>=[];
  const add=(key:string,bytes:Buffer)=>{objects.set(`${prefix}/${key}`,bytes);descriptors.push({key,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});};
  add('metadata.json.gz',gzipSync(JSON.stringify({stocks})));add('benchmarks.json.gz',gzipSync('{}'));
  const groups=new Map<number,string[]>();
  for(const symbol of ['AAA','BBB'])groups.set(shard(symbol),[...(groups.get(shard(symbol))??[]),symbol]);
  for(let index=0;index<32;index++) {
    const name=String(index).padStart(2,'0');
    add(`shards/${name}.bin.gz`,binary(groups.get(index)??[]));
    add(`auxiliary/${name}.json.gz`,gzipSync(JSON.stringify({delivery:{},earnings:{},breadth:{}})));
  }
  const manifest={revision,session,schemaVersion:7,engineVersion:'1',shards:32,objects:descriptors};
  const get=vi.fn(async(key:string)=>{
    if(key===`${prefix}/manifest.json`)return {json:async()=>manifest};
    const bytes=objects.get(key);return bytes ? {arrayBuffer:async()=>Uint8Array.from(bytes).buffer} : null;
  });
  let active=revision;
  vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({revision:active,sessionDate:session,schemaVersion:7}))));
  const entries=new Map<string,Response>();
  vi.stubGlobal('caches',{default:{match:vi.fn(async(key:Request)=>entries.get(key.url)?.clone()),
    put:vi.fn(async(key:Request,response:Response)=>{entries.set(key.url,response.clone());})}});
  const pending:Promise<unknown>[]=[];
  const context={waitUntil:(promise:Promise<unknown>)=>{pending.push(promise);}} as unknown as ExecutionContext;
  const env={ALLOWED_ORIGINS:'https://app.example',SCANNER_RELEASE_URL:'https://app.example/data/current.json',SCANNER_DATA:{get}} as any;
  const request={datasetRevision:revision,asOfDate:session,universe:'custom',customSymbols:['AAA'],
    expressionTree:{type:'condition',condition:{conditionId:'ADX',parameters:{period:14,comparison:'ABOVE',value:1}}},page:1,pageSize:1};
  return {get,setActive:(value:string)=>{active=value;},
    async run(overrides:Record<string,unknown>={},origin='https://app.example') {
      const response=await worker.fetch(new Request('https://worker.example/v1/screens/run',{method:'POST',
        headers:{origin,'content-type':'application/json'},body:JSON.stringify({...request,...overrides})}),env,context);
      await Promise.all(pending.splice(0));return {response,body:await response.json() as any};
    }};
}
afterEach(()=>vi.unstubAllGlobals());
describe('scanner execution and match caching',()=>{
  it('reads only selected symbol shards for a custom universe',async()=>{
    const f=fixture(),{response,body}=await f.run();
    expect(response.status).toBe(200);expect(body.rows.map((row:any)=>row.symbol)).toEqual(['AAA']);
    const keys=f.get.mock.calls.map(([key])=>key);
    expect(keys.filter(key=>key.includes('/shards/'))).toEqual([`${prefix}/shards/${String(shard('AAA')).padStart(2,'0')}.bin.gz`]);
    expect(keys.filter(key=>key.includes('/auxiliary/'))).toHaveLength(1);
  });
  it('reuses matches across page sizes, pages, sorting and reordered custom symbols',async()=>{
    const f=fixture(),first=await f.run({customSymbols:['BBB','AAA']});
    expect(first.body.matchCount).toBe(2);expect(first.body.rows[0].symbol).toBe('AAA');f.get.mockClear();
    const second=await f.run({customSymbols:['aaa','BBB','AAA'],page:2});
    expect(second.body.rows[0].symbol).toBe('BBB');expect(f.get).not.toHaveBeenCalled();
    const sorted=await f.run({customSymbols:['AAA','BBB'],sort:{field:'symbol',direction:'desc'},pageSize:2});
    expect(sorted.body.rows.map((row:any)=>row.symbol)).toEqual(['BBB','AAA']);
    expect(sorted.body.perConditionCoverage).toEqual(first.body.perConditionCoverage);expect(f.get).not.toHaveBeenCalled();
  });
  it('validates pagination and current revision even when matches are cached',async()=>{
    const f=fixture();await f.run();f.get.mockClear();
    expect((await f.run({page:0})).response.status).toBe(400);expect((await f.run({pageSize:101})).response.status).toBe(400);
    f.setActive('b'.repeat(64));expect((await f.run()).response.status).toBe(400);expect(f.get).not.toHaveBeenCalled();
  });
  it('does not fetch history for scalar text and applies stale metadata checks',async()=>{
    const f=fixture(),{response,body}=await f.run({customSymbols:['AAA','STALE'],textQuery:'Market Cap > 2000 AND Close Price > 50 DMA'});
    expect(response.status).toBe(200);expect(body.matchCount).toBe(1);
    expect(f.get.mock.calls.map(([key])=>key)).toEqual([`${prefix}/manifest.json`,`${prefix}/metadata.json.gz`]);
    expect(body.unavailableDiagnostics).toContainEqual({conditionId:'FIELD_COMPARISON',reason:'required data unavailable',affectedCount:1});
    expect(body.warnings).toEqual([]);
  });
  it('preserves unavailable history under negation and mixed OR groups',async()=>{
    const f=fixture(),{body}=await f.run({customSymbols:['MISSING'],expressionTree:{type:'group',operator:'any',children:[
      {type:'condition',condition:{conditionId:'ADX',parameters:{period:14,comparison:'ABOVE',value:1},isNegated:true}},
      {type:'condition',condition:{conditionId:'MARKETCAP',parameters:{comparison:'ABOVE',valueCr:2000}}},
    ]}});
    expect(body.rows.map((row:any)=>row.symbol)).toEqual(['MISSING']);
    expect(body.unavailableDiagnostics).toContainEqual({conditionId:'ADX',reason:'required data unavailable',affectedCount:1});
    expect(body.warnings).toContain('1 equities have no aligned history in this revision.');
  });
  it('does not leak cached CORS headers into another origin',async()=>{
    const f=fixture();await f.run();const {response}=await f.run({},'https://other.example');
    expect(response.headers.has('Access-Control-Allow-Origin')).toBe(false);
  });
});
