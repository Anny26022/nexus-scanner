import {afterEach, describe, expect, it, vi} from 'vitest';
import {validateAiScreenResult} from '../api/aiScreenerContract';
import {compileNaturalLanguageQuery} from '../api/aiScreenerCompiler';

const clause = {sourceText:'close above 200 EMA',status:'EXACT',conditionId:'PRICE_VS_EMA',
  parameters:{period:200,comparison:'ABOVE',persistDays:1},label:'Untrusted AI label'};
const result = (clauses: unknown[] = [clause]) => ({name:'Trend screen',summary:'Price above EMA.',matchMode:'all',clauses});

describe('AI screen validation', () => {
  it('reconstructs conditions and descriptions rather than trusting model maps or labels', () => {
    const validated = validateAiScreenResult({...result(),conditionsMap:{injected:{conditionId:'DIVERGENCE'}}});
    expect(Object.keys(validated.conditionsMap)).toEqual(['ai_0']);
    expect(validated.conditionsMap.ai_0.parameters).toEqual(clause.parameters);
    expect(validated.clauses[0].label).not.toBe(clause.label);
  });
  it.each([
    {...clause,conditionId:'DIVERGENCE'},
    {...clause,parameters:{...clause.parameters,period:199}},
    {...clause,parameters:{...clause.parameters,period:'200'}},
    {...clause,parameters:{...clause.parameters,persistDays:-1}},
    {...clause,parameters:{...clause.parameters,comparison:'CROSSES_ABOVE'}},
    {...clause,parameters:{...clause.parameters,unknown:1}},
    {...clause,parameters:{period:200}},
    {...clause,status:'APPROXIMATE'},
  ])('keeps unavailable or malformed filters visible without executing them: %j', bad => {
    const validated = validateAiScreenResult(result([bad]));
    expect(validated.conditionsMap).toEqual({});
    expect(validated.unsupportedClauses).toEqual([clause.sourceText]);
  });
  it('preserves OR and unsupported constraints alongside valid conditions', () => {
    const validated = validateAiScreenResult({...result([clause,{sourceText:'MACD crossover',status:'UNSUPPORTED',
      assumption:'Crossovers are unavailable.'}]),matchMode:'any'});
    expect(validated.matchMode).toBe('any');
    expect(Object.keys(validated.conditionsMap)).toHaveLength(1);
    expect(validated.unsupportedClauses).toEqual(['MACD crossover']);
  });
  it('rejects empty screens and invalid logic', () => {
    expect(()=>validateAiScreenResult(result([]))).toThrow();
    expect(()=>validateAiScreenResult({...result(),matchMode:'nested'})).toThrow();
    expect(()=>validateAiScreenResult({...result(),matchMode:['all']})).toThrow();
    expect(()=>validateAiScreenResult(result([{...clause,status:['EXACT']}]))).toThrow();
  });
});

describe('live compiler client', () => {
  afterEach(()=>vi.unstubAllGlobals());
  it('posts only user text and validates the server response', async () => {
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify(result()),{status:200}));
    vi.stubGlobal('fetch',request);
    const compiled = await compileNaturalLanguageQuery('  close above 200 EMA  ');
    expect(request.mock.calls[0][0]).toBe('/api/screener/ai-compile');
    expect(JSON.parse(request.mock.calls[0][1].body)).toEqual({text:'close above 200 EMA'});
    expect(compiled.conditionsMap.ai_0.conditionId).toBe('PRICE_VS_EMA');
  });
  it('surfaces backend failures without substituting regex or default filters', async () => {
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({error:'AI unavailable'}),{status:502})));
    await expect(compileNaturalLanguageQuery('stocks above 200 EMA')).rejects.toThrow('AI unavailable');
  });
});
