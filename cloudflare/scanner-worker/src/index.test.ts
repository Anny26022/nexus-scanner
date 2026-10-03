import { afterEach,describe,expect,it,vi } from 'vitest';
import worker,{validateExpression} from './index';

const execution={waitUntil:vi.fn()} as unknown as ExecutionContext;
function environment(marker=true){const manifest={schemaVersion:7,revision:'a'.repeat(64),session:'2026-10-01'};return {ALLOWED_ORIGINS:'https://app.example,http://localhost:8080',SCANNER_RELEASE_URL:'https://app.example/data/current.json',SCANNER_DATA:{get:vi.fn(async()=>marker?{json:async()=>manifest}:null)} as unknown as R2Bucket};}

describe('scanner worker boundary',()=>{
  afterEach(()=>vi.unstubAllGlobals());
  it('reports active revision health and applies allowlisted CORS',async()=>{
    vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({revision:'a'.repeat(64),sessionDate:'2026-10-01',schemaVersion:7}))));
    const response=await worker.fetch(new Request('https://worker.example/v1/health',{headers:{origin:'https://app.example'}}),environment(),execution);
    expect(response.status).toBe(200);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://app.example');
    expect(await response.json()).toMatchObject({ok:true,session:'2026-10-01'});
  });
  it('never reflects an unapproved origin',async()=>{
    vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({revision:'a'.repeat(64),sessionDate:'2026-10-01',schemaVersion:7}))));
    const response=await worker.fetch(new Request('https://worker.example/v1/health',{headers:{origin:'https://evil.example'}}),environment(),execution);
    expect(response.headers.has('Access-Control-Allow-Origin')).toBe(false);
  });
  it('does not report ready for a malformed commit marker',async()=>{
    vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({revision:'a'.repeat(64),sessionDate:'2026-10-01',schemaVersion:7}))));
    const env=environment() as any;env.SCANNER_DATA.get=vi.fn(async()=>({json:async()=>({schemaVersion:7,revision:'b'.repeat(64),session:'2026-10-01'})}));
    const response=await worker.fetch(new Request('https://worker.example/v1/health'),env,execution);
    expect(response.status).toBe(503);
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
});
