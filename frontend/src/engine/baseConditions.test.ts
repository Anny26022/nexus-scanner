import { describe,it,expect } from 'vitest';
import { evaluateBaseCondition, type SelectedBases } from './baseConditions';
const bases:SelectedBases={HOLDING:{base:{depthPct:25,atrContraction:0.6,volumeDryUp:0.8},continuousHolding:false,holdsPivot:true}};
const condition=(id:string,parameters:Record<string,unknown>)=>({instanceId:'test',conditionId:id,parameters:{stage:'HOLDING',...parameters}});
describe('base conditions',()=>{
  it('preserves strict versus inclusive equality',()=>{
    expect(evaluateBaseCondition(bases,condition('BASE_METRIC',{metric:'base.depthPct',comparison:'LESS',value:25}))).toBe(false);
    expect(evaluateBaseCondition(bases,condition('BASE_METRIC',{metric:'base.depthPct',comparison:'BELOW',value:25}))).toBe(true);
  });
  it('distinguishes strict holding from retests',()=>{
    expect(evaluateBaseCondition(bases,condition('BASE_STAGE',{holdingPolicy:'STRICT'}))).toBe(false);
    expect(evaluateBaseCondition(bases,condition('BASE_STAGE',{holdingPolicy:'RETEST'}))).toBe(true);
  });
  it('does not invent missing base measurements',()=>{
    expect(evaluateBaseCondition({},condition('BASE_STAGE',{}))).toBe(false);
    expect(evaluateBaseCondition(undefined,condition('BASE_STAGE',{}))).toBe(null);
    expect(evaluateBaseCondition({},condition('BASE_METRIC',{metric:'base.depthPct',value:25}))).toBe(null);
  });
  it('returns unavailable for overflowing direct arithmetic',()=>{
    expect(evaluateBaseCondition({HOLDING:{base:{depthPct:1e308,ageSessions:1e308}}},condition('BASE_FORMULA',{metric:'base.depthPct',rightMetric:'base.ageSessions',arithmetic:'MULTIPLY',value:1}))).toBeNull();
  });
  it('evaluates same-base arithmetic and rejects unknown paths',()=>{
    expect(evaluateBaseCondition(bases,condition('BASE_FORMULA',{metric:'base.atrContraction',rightMetric:'base.volumeDryUp',arithmetic:'DIVIDE',comparison:'LESS',value:1}))).toBe(true);
    expect(()=>evaluateBaseCondition({},condition('BASE_METRIC',{metric:'__proto__',value:1}))).toThrow();
  });
});
