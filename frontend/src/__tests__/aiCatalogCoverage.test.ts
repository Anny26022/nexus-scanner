import {describe,expect,it} from 'vitest';
import {createAiFilterCatalog} from '../api/aiFilterCatalog';
import {validateAiScreenResult} from '../api/aiScreenerContract';
import {isAvailableCondition} from '../utils/filterAvailability';
import {conditionValidationError} from '../utils/conditionValidation';
import {FILTER_CONDITION_CATALOG} from '../data/conditionCatalog';
import {PRESET_CATALOG} from '../data/presetCatalog';
import {availableFilterParameters} from '../utils/filterAvailability';
import {tradingViewMetrics} from '../data/tradingViewMetrics';

const choices={SECTOR:['BANKS','INFORMATION TECHNOLOGY'],INDUSTRY:['PRIVATE BANKS','SOFTWARE'],SERIES:['EQ','BE'],
  PRICE_BAND:['2','5','10','20','NO BAND'],INDEX_MEMBERSHIP:['NIFTY 50','NIFTY 500'],TRADINGVIEW_METRIC:tradingViewMetrics.map(m=>m.id)};
const catalog=createAiFilterCatalog(choices);
const compile=(id:string,parameters:Record<string,unknown>,negated=false)=>validateAiScreenResult({name:'Audit',summary:'Audit',matchMode:'all',
  clauses:[{sourceText:'audit',status:'EXACT',conditionId:id,parameters,isNegated:negated}]},catalog);
const defaults=(def:typeof catalog[number])=>Object.fromEntries(def.parameters.map(p=>[p.id,p.defaultValue]));

it('exposes every currently available custom definition and all 45 presets',()=>{
  const expected=[...FILTER_CONDITION_CATALOG,...PRESET_CATALOG].filter(d=>availableFilterParameters(d)!==null).map(d=>d.id).sort();
  expect(catalog.map(d=>d.id).sort()).toEqual(expected);
  expect(catalog.filter(d=>d.id.startsWith('lib-'))).toHaveLength(45);
});
it.each(catalog.map(d=>[d.id,d] as const))('%s: defaults survive validation with every parameter preserved',(id,def)=>{
  expect(compile(id,defaults(def)).conditionsMap.ai_0.parameters).toEqual(defaults(def));
});

const variants=catalog.flatMap(def=>{
  let combinations:Record<string,unknown>[]=[defaults(def)];
  for(const p of def.parameters){
    const values=p.type==='multiselect' ? [...(p.options??[]).map(o=>[o.value]),p.options?.map(o=>o.value)]
      : p.type==='select' ? p.options?.map(o=>o.value) : p.type==='boolean' ? [false,true]
      : p.nullable ? [p.defaultValue,null] : [p.defaultValue];
    combinations=combinations.flatMap(parameters=>(values??[]).map(value=>({...parameters,[p.id]:value})));
  }
  return combinations.map((parameters,index)=>({name:`${def.id}/${index}`,id:def.id,parameters}));
});
describe('finite enum combinations, multiselect choices and preset eligibility switches',()=>{
  it.each(variants)('$name maps exactly or is explicitly rejected by the evaluator',({id,parameters})=>{
    const active={instanceId:'audit',conditionId:id,parameters};
    const expected=isAvailableCondition(active) && !conditionValidationError({audit:active});
    const result=compile(id,parameters);
    expect(Object.keys(result.conditionsMap).length).toBe(expected?1:0);
    if(expected) expect(result.conditionsMap.ai_0.parameters).toEqual(parameters);
  });
});
it('rejects invented taxonomy values and preserves multi-sector arrays',()=>{
  expect(compile('SECTOR',{values:['BANKS','INFORMATION TECHNOLOGY']}).conditionsMap.ai_0.parameters.values).toEqual(choices.SECTOR);
  expect(compile('INDUSTRY',{values:['INVENTED INDUSTRY']}).unsupportedClauses).toHaveLength(1);
});
it('hydrates only published constants and never invents a missing threshold',()=>{
  expect(compile('VOLUME_VS_AVG',{multiple:2}).conditionsMap.ai_0.parameters).toEqual({multiple:2,avgDays:20,withinDays:1});
  expect(compile('VOLUME_VS_AVG',{}).unsupportedClauses).toHaveLength(1);
  expect(compile('VOLUME_VS_AVG',{multiple:2,avgDays:30}).unsupportedClauses).toHaveLength(1);
});
it('preserves negation for strict comparisons and rejects reversed numeric ranges',()=>{
  expect(compile('MARKETCAP',{comparison:'BELOW',valueCr:1000},true).conditionsMap.ai_0.isNegated).toBe(true);
  expect(compile('PRICE_RANGE',{minPrice:100,maxPrice:50}).unsupportedClauses).toHaveLength(1);
});
it('rejects fractional sessions even when the catalogue omits step=1',()=>{
  expect(compile('PRICE_VS_EMA',{period:200,comparison:'ABOVE',persistDays:1.5}).unsupportedClauses).toHaveLength(1);
});
