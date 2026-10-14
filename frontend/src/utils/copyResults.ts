export type CopyGroup = 'symbols' | 'sector' | 'industry' | 'theme' | 'subIndustry' | 'block' | 'macro';
export interface CopyRow { symbol:string; sector?:string; industry?:string }
export interface ThemeClassification {
  schemaVersion:number;
  version:string;
  asOfDate:string;
  records:Record<string, {theme:string|null; subIndustry:string|null; block:string|null; macro:string|null}>;
}
export const copyFormats: Array<{value:CopyGroup; label:string}> = [
  {value:'symbols',label:'TradingView symbols'}, {value:'sector',label:'By sector'},
  {value:'industry',label:'By industry'}, {value:'theme',label:'By theme'},
  {value:'subIndustry',label:'By sub-industry'}, {value:'block',label:'By thematic block'},
  {value:'macro',label:'By macro pillar'},
];
export function formatCopyResults(rows:CopyRow[], group:CopyGroup, taxonomy?:ThemeClassification):string {
  const unique = [...new Map(rows.map(row => [row.symbol,row])).values()];
  if (group === 'symbols') return unique.map(row => `NSE:${row.symbol}`).join(', ');
  const groups = new Map<string,string[]>();
  for (const row of unique) {
    const value = group === 'sector' || group === 'industry' ? row[group] : taxonomy?.records[row.symbol]?.[group];
    const label = value?.trim() || 'Unclassified';
    const symbols = groups.get(label) ?? [];
    symbols.push(`NSE:${row.symbol}`);
    groups.set(label,symbols);
  }
  return [...groups].sort(([a],[b]) => a.localeCompare(b)).map(([label,symbols]) =>
    `###${label.replaceAll(',', ' / ').replace(/[\r\n]/g,' ')}(${symbols.length}),${symbols.join(',')}`).join(',');
}
