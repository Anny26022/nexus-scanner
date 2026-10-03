import { describe,expect,it } from 'vitest';
import { NEXUS_CONDITION_CATALOG } from '../data/conditionCatalog';
import { conditionCapability,expressionPlan } from '../api/capabilityRegistry';
import type { ExpressionNode } from '../types/screener';

const condition=(conditionId:string,parameters:Record<string,unknown>={}):ExpressionNode=>({type:'condition',condition:{instanceId:conditionId,conditionId,parameters}});

describe('condition capabilities',()=>{
  it('assigns every published catalog entry to an execution path',()=>{
    for(const definition of NEXUS_CONDITION_CATALOG){
      const parameters=Object.fromEntries(definition.parameters.map(parameter=>[parameter.id,parameter.defaultValue]));
      const capability=conditionCapability({conditionId:definition.id,instanceId:definition.id,parameters});
      expect(capability.dependencies[0]).toBe('core');
      expect(capability.dependencies.length).toBeGreaterThan(1);
    }
  });
  it('keeps complete nested expressions on the advanced path',()=>{
    const expression:ExpressionNode={type:'group',operator:'any',children:[condition('MARKETCAP',{comparison:'ABOVE',valueCr:1000}),{type:'group',operator:'all',children:[condition('VCP_LEGS'),condition('PE_RATIO',{comparison:'LESS',value:20,reportType:'PREFER_CONSOLIDATED'})]}]};
    expect(expressionPlan(expression)).toMatchObject({browser:false});
    expect(expressionPlan(expression).dependencies).toContain('advanced');
  });
  it('keeps compatible scalar expressions in the browser',()=>{
    const expression=condition('PRICE_CHANGE_PCT',{overDays:21,comparison:'GREATER',pct:10});
    expect(expressionPlan(expression)).toEqual({browser:true,dependencies:['core','technical']});
  });
  it('routes unsupported scalar parameter combinations to the complete advanced expression',()=>{
    expect(expressionPlan(condition('PRICE_VS_EMA',{period:20,comparison:'ABOVE',persistDays:10})).browser).toBe(false);
    expect(expressionPlan(condition('GAP_UP',{minGapPct:5,withinDays:3})).browser).toBe(false);
    expect(expressionPlan(condition('trend_price_vs_ma',{maType:'EMA',maPeriod:50,operator:'above'})).browser).toBe(false);
    expect(expressionPlan(condition('PRICE_VS_EMA',{period:20,comparison:'ABOVE',persistDays:1})).browser).toBe(true);
  });
});
