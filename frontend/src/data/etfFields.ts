import registry from '../../../DO NOT DELETE EDL PIPELINE/etf_fields.json';
import type {ConditionCategory, ConditionDef} from '../types/screener';

export const etfGroups = registry.groups;
export const etfGroup = (id: string) => etfGroups.find(group => `ETF_${group.id}` === id);
export const isEtfCondition = (id: string) => id.startsWith('ETF_');
const categories: Record<string, ConditionCategory> = {
  securityInfo:'range', marketData:'liquidity', technicals:'trend', analysis:'fundamentals', dividends:'momentum',
};
export const etfCategoryTabs: Array<{id: ConditionCategory | 'all'; label: string}> = [
  {id:'all', label:'All'}, {id:'range', label:'Security info'}, {id:'liquidity', label:'Market data'},
  {id:'trend', label:'Technicals'}, {id:'fundamentals', label:'Analysis'}, {id:'momentum', label:'Dividends'},
];
export function etfFieldLabel(field: string) {
  const [key, resolution] = field.split('|');
  const periods: Record<string,string> = {'1':'1 min','5':'5 min','15':'15 min','30':'30 min',
    '60':'1 hour','120':'2 hours','240':'4 hours','1W':'1 week','1M':'1 month'};
  const horizon = key.match(/^(?:Perf|fund_flows|aum_perf|nav_perf|nav_total_return)\.(.+)$/)?.[1];
  if (horizon) return ({W:'1 week',Y:'1 year',YTD:'Year to date'} as Record<string,string>)[horizon]
    ?? horizon.replace('M',' months').replace('Y',' years');
  const name = key.replace('[1]', ' (previous bar)').replaceAll('_',' ').replaceAll('.', ' · ');
  return `${name} · ${resolution ? periods[resolution] ?? resolution : '1 day'}`;
}
export const etfConditionCatalog: ConditionDef[] = etfGroups.map((group): ConditionDef => ({
  id:`ETF_${group.id}`, label:group.label, category:categories[group.category],
  description:'Filter the selected ETF snapshot. Missing values are unavailable; each listing retains its quote date.',
  parameters:[
    {id:'metric', label:'Field / timeframe', type:'select', defaultValue:group.fields[0],
      options:group.fields.map(value => ({value, label:group.fields.length === 1 ? group.label : etfFieldLabel(value)}))},
    ...(group.type === 'number' ? [
      {id:'comparison', label:'Comparison', type:'select' as const, defaultValue:'ABOVE', options:[
        {value:'ABOVE',label:'≥ At least'}, {value:'BELOW',label:'≤ At most'},
        {value:'GREATER',label:'> Greater than'}, {value:'LESS',label:'< Less than'}, {value:'EQUAL',label:'= Equal to'},
      ]},
      {id:'value', label:'Value', type:'number' as const, defaultValue:0, step:0.1},
    ] : [{id:'values', label:'Values', type:'multiselect' as const, defaultValue:[], options:[]}]),
  ],
})).sort((a,b) => etfCategoryTabs.findIndex(tab => tab.id === a.category) - etfCategoryTabs.findIndex(tab => tab.id === b.category));
