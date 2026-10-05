import { baseMetricLabel } from '../utils/baseMetricLabel';
import { ConditionDef, ConditionCategory } from '../types/screener';
import definitions from './presetDefinitions.json';

const categories: Record<string, ConditionCategory> = {
  'Momentum & Leadership': 'momentum', Breakouts: 'trend',
  'Bases & Contraction': 'range', 'Pullbacks & Reclaims': 'trend',
  'Volume & Delivery': 'momentum', Gaps: 'momentum', Reversals: 'relative_strength',
  'Earnings & Value': 'fundamentals', 'Regime & Universe': 'liquidity',
};

export const PRESET_CATALOG: ConditionDef[] = definitions.map(p => ({
  id: p.id, label: p.name, category: categories[p.category] ?? 'trend',
  description: p.rules.join('; '), parameters: p.id.startsWith('lib-nexus-') ? p.expression.children.flatMap<ConditionDef['parameters'][number]>((node,index)=>{
    const parameters=node.params as Record<string,unknown>;
    if(node.kind==='BASE_STAGE')return parameters.stage!=='HOLDING'?[]:[{id:'holdingPolicy',label:'Holding policy',type:'select' as const,defaultValue:parameters.holdingPolicy,
      options:[{label:'Any',value:'ANY'},{label:'Always above pivot',value:'STRICT'},{label:'Retests allowed',value:'RETEST'}]}];
    return [{id:`threshold${index}`,label:`${baseMetricLabel(String(parameters.metric))} ${{ABOVE:'≥',BELOW:'≤',GREATER:'>',LESS:'<',EQUAL:'='}[String(parameters.comparison)] ?? parameters.comparison}`,type:'number' as const,defaultValue:parameters.value}];
  }) : [],
}));
