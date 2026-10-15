import fields from '../../../DO NOT DELETE EDL PIPELINE/tradingview_fields.json';
import type {ConditionCategory, ConditionDef} from '../types/screener';

export const tradingViewMetrics = fields.map(field => ({...field, id:`${field.section}.${field.key}`}));
export const tradingViewFilterGroups: Record<string, {category:ConditionCategory; label:string}> = {
  TV_TECHNICALS: {category:'trend', label:'TradingView technicals'},
  TV_PERFORMANCE: {category:'momentum', label:'TradingView momentum & performance'},
  TV_MARKET: {category:'liquidity', label:'TradingView market & liquidity'},
  TV_FINANCIALS: {category:'fundamentals', label:'TradingView financials'},
};
export const isTradingViewCondition = (id:string) => Object.hasOwn(tradingViewFilterGroups, id);
export const tradingViewConditionCatalog: ConditionDef[] = Object.entries(tradingViewFilterGroups).map(([id, group]) => {
  const options = tradingViewMetrics.filter(metric => metric.category === group.category)
    .map(metric => ({value:metric.id, label:metric.label}));
  return {id, ...group, description:'Compare a TradingView value from the published daily snapshot. Units and reporting periods are shown in the metric name.', parameters:[
    {id:'metric', label:'Metric', type:'select', defaultValue:options[0].value, options},
    {id:'comparison', label:'Comparison', type:'select', defaultValue:'ABOVE', options:[
      {value:'ABOVE',label:'≥ At least'}, {value:'BELOW',label:'≤ At most'},
      {value:'GREATER',label:'> Greater than'}, {value:'LESS',label:'< Less than'}, {value:'EQUAL',label:'= Equal to'},
    ]},
    {id:'value', label:'Value', type:'number', defaultValue:0, step:0.1},
  ]};
});
