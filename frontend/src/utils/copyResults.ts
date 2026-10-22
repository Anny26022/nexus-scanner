export type CopyGroup = 'symbols' | 'sector' | 'industry' | 'theme' | 'subIndustry' | 'block' | 'macro';
export interface CopyRow { symbol:string; sector?:string; industry?:string }
export interface ThemeClassification {
  schemaVersion:number;
  version:string;
  asOfDate:string;
  records:Record<string, {theme:string|null; subIndustry:string|null; block:string|null; macro:string|null}>;
}
export const copyFormats: Array<{value:CopyGroup; label:string}> = [
  {value:'symbols',label:'Symbols'}, {value:'sector',label:'Sector'},
  {value:'industry',label:'Industry'}, {value:'theme',label:'Theme'},
  {value:'subIndustry',label:'Sub-industry'}, {value:'block',label:'Thematic block'},
  {value:'macro',label:'Macro pillar'},
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
  return [...groups].sort(([a, sa], [b, sb]) =>
    (sb.length - sa.length) || (a === 'Unclassified' ? 1 : b === 'Unclassified' ? -1 : a.localeCompare(b))
  ).map(([label,symbols]) =>
    `###${label.replaceAll(',', ' / ').replace(/[\r\n]/g,' ')}(${symbols.length}),${symbols.join(',')}`).join(',');
}

export function escapeCsvField(value: unknown): string {
  if (value == null) return '';
  const str = String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function formatCsvResults(
  rows: Record<string, unknown>[],
  columns: { id: string; label: string; getValue?: (row: any) => unknown }[]
): string {
  const header = columns.map(c => escapeCsvField(c.label)).join(',');
  const lines = rows.map(row =>
    columns.map(c => {
      const val = c.getValue ? c.getValue(row) : row[c.id];
      return escapeCsvField(val);
    }).join(',')
  );
  return [header, ...lines].join('\r\n');
}
