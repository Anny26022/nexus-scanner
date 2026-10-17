import {describe, expect, it, vi} from 'vitest';
import {createAiFilterCatalog} from '../api/aiFilterCatalog';
import {compactCatalog, type CompactParameterSet} from '../../../workers/screener-ai/compactCatalog';
import {materializeCompilerResult} from '../../../workers/screener-ai/compilerResult';
import {compileWithFallback, compilerPrompt} from '../../../workers/screener-ai/compiler';
import {compilationCacheKey, readCompilation, storeCompilation, COMPILATION_CACHE_TTL,
  type CompilationCache} from '../../../workers/screener-ai/compilationCache';

const catalog = createAiFilterCatalog();
const query = 'Latest close above 200 EMA';
const raw = {matchMode:'all',clauses:[{sourceText:query,status:'EXACT',conditionId:'PRICE_VS_MAS',parameters:{rules:['ABOVE_EMA_200']}}]};
const complete = () => ({...materializeCompilerResult(raw,catalog),
  compilation:{model:'test-model',attempts:1,cacheHit:false,inputTokens:100,outputTokens:20}});

function memoryCache(): CompilationCache {
  const entries = new Map<string,Response>();
  return {match:vi.fn(async key=>entries.get(key.url)?.clone()),
    put:vi.fn(async (key,response)=>{entries.set(key.url,response.clone());})};
}

describe('compact compiler context',()=>{
  it('preserves every filter and parameter constraint, deduplicating shared definitions',()=>{
    const encoded=compactCatalog(catalog);
    expect(encoded.filters).toHaveLength(catalog.length);
    let parameterCount=0;
    for (const [index,def] of catalog.entries()) {
      const [id,label,meaning,reference]=encoded.filters[index];
      const parameters=typeof reference.use === 'number' ? encoded.shared[reference.use] : reference as CompactParameterSet;
      expect([id,label,meaning]).toEqual([def.id,def.label,def.description]);
      for (const p of def.parameters) {
        parameterCount++;
        const spec=parameters[p.id];
        expect(spec).toMatchObject({t:p.type,l:p.label,d:p.defaultValue});
        expect(spec.min).toBe(p.min);expect(spec.max).toBe(p.max);
        expect(spec.step).toBe(p.step);expect(spec.u).toBe(p.unit);
        expect(spec.nullable ?? false).toBe(p.nullable ?? false);
        if(p.options) {
          expect(spec.e).toEqual(p.options.map(o=>o.value));
          if(p.options.some(o=>o.label!==String(o.value)))expect(spec.labels).toEqual(p.options.map(o=>o.label));
        }
      }
    }
    expect(encoded.shared.length).toBeGreaterThan(0);
    expect(encoded.shared.flatMap(set=>Object.keys(set)).length).toBeLessThan(parameterCount);
    expect(JSON.stringify(encoded).length).toBeLessThan(JSON.stringify(catalog).length*.7);
  });
  it('requests no display fields, preserving brief assumptions and source phrases',()=>{
    const prompt=compilerPrompt(catalog);
    expect(prompt).toContain('Do not emit names, summaries, labels');
    expect(prompt).toContain('Keep necessary assumptions brief');
    expect(prompt).not.toContain('Return JSON {name,summary');
  });
});

describe('local screen presentation',()=>{
  it('builds names, summaries and labels from minimal model output',()=>{
    const result=materializeCompilerResult({...raw,name:'Untrusted title',summary:'Untrusted summary'},catalog);
    expect(result.name).toBe('Close > EMA200');
    expect(result.summary).toBe('1 filter built. Match all conditions.');
    expect(result.clauses[0].label).toBe('Close > EMA200');
  });
  it('restores only fixed parameters and refuses missing variable thresholds',()=>{
    const clause={sourceText:'ADX at least 25',status:'EXACT',conditionId:'ADX',parameters:{comparison:'ABOVE',value:25}};
    const result=materializeCompilerResult({matchMode:'all',clauses:[clause]},catalog);
    expect(result.conditionsMap.ai_0.parameters).toEqual({period:14,comparison:'ABOVE',value:25});
    const invalid=materializeCompilerResult({matchMode:'all',clauses:[{...clause,parameters:{comparison:'ABOVE'}}]},catalog);
    expect(invalid.conditionsMap).toEqual({});
  });
  it('accepts a complete minimal response without a repair inference',async()=>{
    const run=vi.fn().mockResolvedValue({response:JSON.stringify(raw)});
    const result=await compileWithFallback(query,catalog,run);
    expect(result.name).toBe('Close > EMA200');
    expect(run).toHaveBeenCalledTimes(1);
  });
  it('rejects a persistence substitution for an explicit latest-close request before caching',async()=>{
    const wrong={matchMode:'all',clauses:[{sourceText:query,status:'EXACT',conditionId:'PRICE_VS_EMA',
      parameters:{period:200,comparison:'ABOVE',persistDays:1}}]};
    const run=vi.fn().mockResolvedValueOnce({response:JSON.stringify(wrong)}).mockResolvedValueOnce({response:JSON.stringify(raw)});
    const result=await compileWithFallback(query,catalog,run);
    expect(result.conditionsMap.ai_0.conditionId).toBe('PRICE_VS_MAS');
    expect(run).toHaveBeenCalledTimes(2);
  });
});

describe('validated compilation cache',()=>{
  const url=new URL('https://scanner.example/api/screener/ai-compile');
  it('invalidates on request, dataset or compiler/catalogue changes',async()=>{
    const key=await compilationCacheKey(url,'revision-a','catalog-a',query);
    expect((await compilationCacheKey(url,'revision-a','catalog-a',` ${query} `)).url).toBe(key.url);
    for (const args of [['revision-b','catalog-a',query],['revision-a','catalog-b',query],['revision-a','catalog-a','different']] as const) {
      expect((await compilationCacheKey(url,args[0],args[1],args[2])).url).not.toBe(key.url);
    }
    expect(key.url).not.toContain('EMA');
  });
  it('a repeated validated compilation bypasses inference and retains the six-hour TTL',async()=>{
    const cache=memoryCache(), key=await compilationCacheKey(url,'revision','catalog',query), infer=vi.fn(complete);
    const load=async()=>{
      const hit=await readCompilation(cache,key,catalog);
      if(hit)return hit;
      const fresh=infer();await storeCompilation(cache,key,fresh,catalog);return fresh;
    };
    expect((await load()).compilation?.cacheHit).toBe(false);
    expect((await load()).compilation?.cacheHit).toBe(true);
    expect(infer).toHaveBeenCalledTimes(1);
    const response=await cache.match(key);
    expect(response?.headers.get('Cache-Control')).toBe(`public, max-age=${COMPILATION_CACHE_TTL}`);
  });
  it('does not cache partial or unsupported interpretations',async()=>{
    const cache=memoryCache(),key=await compilationCacheKey(url,'revision','catalog',query);
    const result=materializeCompilerResult({matchMode:'all',clauses:[{sourceText:'RSI crossover',status:'UNSUPPORTED'}]},catalog);
    await storeCompilation(cache,key,{...result,compilation:complete().compilation},catalog);
    expect(cache.put).not.toHaveBeenCalled();
  });
  it.each(['corrupt','obsolete','unavailable','oversized'])('treats a %s cache entry as a miss',async kind=>{
    const cache=memoryCache(),key=await compilationCacheKey(url,'revision','catalog',query);
    if(kind==='unavailable')vi.mocked(cache.match).mockRejectedValue(new Error('Cache unavailable'));
    else await cache.put(key,kind==='corrupt'?new Response('invalid json'):kind==='oversized'?new Response(' '.repeat(200001))
      :Response.json({...complete(),clauses:[{...raw.clauses[0],conditionId:'removed-filter'}]}));
    expect(await readCompilation(cache,key,catalog)).toBeUndefined();
  });
});
