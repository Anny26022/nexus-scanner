import { baseMetricLabel } from '../utils/baseMetricLabel';
import { ConditionDef, ConditionCategory, ParameterSpec } from '../types/screener';
import definitions from './presetDefinitions.json';

const categories: Record<string, ConditionCategory> = {
  'Momentum & Leadership': 'momentum', Breakouts: 'trend',
  'Bases & Contraction': 'range', 'Pullbacks & Reclaims': 'trend',
  'Volume & Delivery': 'momentum', Gaps: 'momentum', Reversals: 'relative_strength',
  'Earnings & Value': 'fundamentals', 'Regime & Universe': 'liquidity',
};

function setupParameters(p: {id:string;setupFamily?:string}): ParameterSpec[] {
  if(!p.setupFamily)return [];
  return [
    {id:'setupStage',label:'Setup stage',type:'select',defaultValue:'FORMING',options:['FORMING','FRESH_BREAKOUT','HOLDING','PLAYED_OUT'].map(value=>({label:value.replaceAll('_',' '),value}))},
    {id:'holdingPolicy',label:'Pivot holding',type:'select',defaultValue:'ANY',options:[{label:'Any',value:'ANY'},{label:'Continuous',value:'STRICT'},{label:'Retests allowed',value:'RETEST'}]},
    {id:'maxBaseDepth',label:'Family maximum depth (%)',type:'number',defaultValue:['vcp','ipo'].includes(p.setupFamily)?35:95,min:1,max:95},
    {id:'minContractionLegs',label:'Confirmed contraction legs (0 or 2–10)',type:'number',defaultValue:0,min:0,max:10,step:1},
    {id:'maxContractionLegRatio',label:'Maximum successive leg ratio',type:'number',defaultValue:1,min:0,max:2},
    {id:'requireFirstBase',label:'First eligible base only',type:'boolean',defaultValue:p.setupFamily==='ipo'},
    ...(p.setupFamily==='vcp'?[{id:'contractionMethod',label:'Contraction measurement',type:'select' as const,defaultValue:'RAW_TR',options:[{label:'Raw daily TR% means',value:'RAW_TR'},{label:'Wilder ATR% means',value:'WILDER_ATR'},{label:'Simple ATR% means',value:'SIMPLE_ATR'}]}]:[]),
    ...(p.setupFamily==='blue-sky'?[{id:'athPolicy',label:'Historical high policy',type:'select' as const,defaultValue:'CLOSING_AVAILABLE',options:[{label:'Available closing history',value:'CLOSING_AVAILABLE'},{label:'Available intraday history',value:'INTRADAY_AVAILABLE'},{label:'Audited lifetime intraday history',value:'AUDITED_INTRADAY'}]}]:[]),
  ];
}

export const PRESET_CATALOG: ConditionDef[] = definitions.map(p => ({
  id: p.id, label: p.name, category: categories[p.category] ?? 'trend',
  description: p.rules.join('; '), parameters: p.id.startsWith('lib-nexus-') ? [...setupParameters(p),...p.expression.children.flatMap<ConditionDef['parameters'][number]>((node,index)=>{
    const parameters=node.params as Record<string,unknown>;
    if((p as {setupFamily?:string}).setupFamily && (node.kind==='BASE_STAGE'||parameters.metric==='firstEligibleBase'||(parameters.metric==='base.depthPct'&&parameters.comparison==='BELOW')))return [];
    if(node.kind==='BASE_STAGE')return parameters.stage!=='HOLDING'?[]:[{id:'holdingPolicy',label:'Holding policy',type:'select' as const,defaultValue:parameters.holdingPolicy,
      options:[{label:'Any',value:'ANY'},{label:'Always above pivot',value:'STRICT'},{label:'Retests allowed',value:'RETEST'}]}];
    return [{id:`threshold${index}`,label:`${baseMetricLabel(String(parameters.metric))} ${{ABOVE:'≥',BELOW:'≤',GREATER:'>',LESS:'<',EQUAL:'='}[String(parameters.comparison)] ?? parameters.comparison}`,type:'number' as const,defaultValue:parameters.value}];
  })] : [],
}));
