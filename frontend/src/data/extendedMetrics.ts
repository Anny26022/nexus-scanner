import fields from '../../../DO NOT DELETE EDL PIPELINE/tradingview_fields.json';
import type {ConditionCategory, ConditionDef} from '../types/screener';

export const extendedMetrics = fields.map(field => ({...field, id:`${field.section}.${field.key}`}));
export const extendedFilterGroups: Record<string, {category:ConditionCategory; label:string}> = {
  TV_TECHNICALS: {category:'trend', label:'Technical Indicators'},
  TV_PERFORMANCE: {category:'momentum', label:'Period Returns & Momentum'},
  TV_MARKET: {category:'liquidity', label:'Average Volume & Turnover'},
  TV_FINANCIALS: {category:'fundamentals', label:'Balance Sheet & Statement Ratios'},
};
export const isExtendedCondition = (id:string) => Object.hasOwn(extendedFilterGroups, id) || id.startsWith('TV_') || id.startsWith('TRADINGVIEW');
export const extendedConditionCatalog: ConditionDef[] = Object.entries(extendedFilterGroups).map(([id, group]) => {
  const options = extendedMetrics.filter(metric => metric.category === group.category)
    .map(metric => ({value:metric.id, label:metric.label}));
  return {id, ...group, description:'Compare indicator values from the published daily session. Units and reporting periods are shown in the metric name.', parameters:[
    {id:'metric', label:'Metric', type:'select', defaultValue:options[0].value, options},
    {id:'comparison', label:'Comparison', type:'select', defaultValue:'ABOVE', options:[
      {value:'ABOVE',label:'≥ At least'}, {value:'BELOW',label:'≤ At most'},
      {value:'GREATER',label:'> Greater than'}, {value:'LESS',label:'< Less than'}, {value:'EQUAL',label:'= Equal to'},
    ]},
    {id:'value', label:'Value', type:'number', defaultValue:0, step:0.1},
  ]};
});
