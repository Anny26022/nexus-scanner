import {expect,it,vi} from 'vitest';
import {compileWithFallback,PRIMARY_MODEL,FALLBACK_MODEL,compilerPrompt} from '../../../workers/screener-ai/compiler';
import {createAiFilterCatalog} from '../api/aiFilterCatalog';
const catalog=createAiFilterCatalog();
const query='Latest close above 200 EMA';
const valid={name:'EMA',summary:'EMA screen',matchMode:'all',clauses:[{sourceText:query,status:'EXACT',conditionId:'PRICE_VS_MAS',parameters:{rules:['ABOVE_EMA_200']}}]};
const output=(raw:unknown)=>({response:JSON.stringify(raw),usage:{prompt_tokens:100,completion_tokens:20}});

it('accepts OpenAI-style Qwen output and records actual usage',async()=>{
  const run=vi.fn().mockResolvedValue({choices:[{message:{content:JSON.stringify(valid)},finish_reason:'stop'}],usage:{prompt_tokens:100,completion_tokens:20}});
  const result=await compileWithFallback(query,catalog,run);
  expect(result.compilation).toMatchObject({model:PRIMARY_MODEL,attempts:1,inputTokens:100,outputTokens:20});
});
it.each(['provider','json','parameters','omission','truncation'])('uses exactly one stronger-model attempt after %s failure',async(kind)=>{
  const first=kind==='json' ? {response:'invalid'} : kind==='parameters' ? output({...valid,clauses:[{...valid.clauses[0],parameters:{rules:['ABOVE_EMA_333']}}]})
    : kind==='omission' ? output({...valid,clauses:[{...valid.clauses[0],sourceText:'Latest close'}]})
    : {choices:[{message:{content:JSON.stringify(valid)},finish_reason:'length'}]};
  const run=vi.fn();
  if(kind==='provider')run.mockRejectedValueOnce(new Error('Provider unavailable'));else run.mockResolvedValueOnce(first);
  run.mockResolvedValueOnce(output(valid));
  const result=await compileWithFallback(query,catalog,run);
  expect(run).toHaveBeenCalledTimes(2);
  expect(run.mock.calls.map(c=>c[0])).toEqual([PRIMARY_MODEL,FALLBACK_MODEL]);
  expect(result.compilation.attempts).toBe(2);
  expect(run.mock.calls[1][1].messages[1].content).toBe(query);
});
it('keeps genuine unsupported requests unsupported without spending a second inference',async()=>{
  const run=vi.fn().mockResolvedValue(output({name:'Unsupported',summary:'No RSI filter',matchMode:'all',clauses:[{sourceText:'RSI crossover',status:'UNSUPPORTED',assumption:'No supported crossover condition.'}]}));
  const result=await compileWithFallback('RSI crossover',catalog,run);
  expect(result.unsupportedClauses).toEqual(['RSI crossover']);expect(run).toHaveBeenCalledTimes(1);
});
it('fails closed when both models fail and does not retry after cancellation',async()=>{
  const run=vi.fn().mockRejectedValue(new Error('Inference failed'));
  await expect(compileWithFallback(query,catalog,run)).rejects.toThrow('No model');
  expect(run).toHaveBeenCalledTimes(2);
  const controller=new AbortController();controller.abort();run.mockClear();
  await expect(compileWithFallback(query,catalog,run,{signal:controller.signal})).rejects.toThrow();expect(run).not.toHaveBeenCalled();
});
it('keeps every filter in the compact prompt while materially reducing catalogue characters',()=>{
  const prompt=compilerPrompt(catalog);for(const d of catalog)expect(prompt).toContain(d.id);
  expect(prompt.length).toBeLessThan(JSON.stringify(catalog).length*.75);
});
