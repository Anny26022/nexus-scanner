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
