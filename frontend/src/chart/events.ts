import type { ChartSnapshot } from '../api/realAdapter';
import type { Candle } from './model';

export type ChartEvent={id:string;date:string;kind:'earnings'|'action'|'news';title:string;detail?:string;source?:string;url?:string};
const text=(value:unknown)=>typeof value==='string'&&value.trim()?value.trim():undefined;
export function chartEvents(snapshot:Pick<ChartSnapshot,'earnings'|'corporateActions'|'marketNews'|'regulatoryAnnouncements'>):ChartEvent[] {
  const groups=[['earnings',snapshot.earnings,'filing_date'],['action',snapshot.corporateActions,'ex_date'],['news',[...snapshot.marketNews,...snapshot.regulatoryAnnouncements??[]],'date']] as const;
  const unique=new Map<string,ChartEvent>();
  for(const [kind,rows,key] of groups) for(const row of rows) {
    const date=typeof row[key]==='string'?(row[key] as string).slice(0,10):'';
    if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(date))||new Date(date).toISOString().slice(0,10)!==date) continue;
    const title=String(kind==='action'?row.source_details??row.action_type??'Corporate action':kind==='earnings'?row.filing_caption??row.filing_descriptor??'Earnings filing':row.headline??'News');
    // Some published ledger rows link a trading-window notice, not a results filing.
    const eventKind=kind==='earnings'&&/trading\s+window/i.test(title)?'news':kind;
    const id=`${eventKind}:${date}:${title}`;
    // News carries a summary, filings their body text; only web links are kept.
    const detail=text(row.summary)??text(row.body);
    const url=[row.url,row.filing_url].map(text).find(link=>link&&/^https?:\/\//i.test(link));
    const source=text(row.source);
    unique.set(id,{id,date,kind:eventKind,title,...(detail&&detail!==title?{detail}:{}),...(source?{source}:{}),...(url?{url}:{})});
  }
  return [...unique.values()].sort((a,b)=>a.date.localeCompare(b.date)||a.id.localeCompare(b.id));
}

// A replayed weekly/monthly bar is a closed aggregate, not its opening session.
export function revealedThrough(candles:readonly Candle[],index:number|null,asOf:string):string {
  if(index===null||index===candles.length-1) return asOf;
  return new Date(Date.parse(candles[index+1].date)-86_400_000).toISOString().slice(0,10);
}

/** TradingView-style lettered badges for the event strip: N news, E earnings, S split, B bonus, D dividend, R rights, C other actions. */
export const EVENT_BADGES = [
  ['news', 'N', 'News', '#2962ff'], ['earnings', 'E', 'Earnings', '#f23645'], ['split', 'S', 'Split', '#9c27b0'],
  ['bonus', 'B', 'Bonus', '#089981'], ['dividend', 'D', 'Dividend', '#ff9800'], ['rights', 'R', 'Rights issue', '#00bcd4'],
  ['action', 'C', 'Other corporate action', '#787b86'],
] as const;
export type EventBadgeKey = typeof EVENT_BADGES[number][0];
export type EventBadgeStyles = Partial<Record<EventBadgeKey, {visible?: boolean; color?: string}>>;

export function eventBadgeKey(event: Pick<ChartEvent, 'kind' | 'title'>): EventBadgeKey {
  if (event.kind !== 'action') return event.kind;
  const title = event.title.toLowerCase();
  if (/split|sub-?division/.test(title)) return 'split';
  if (/bonus/.test(title)) return 'bonus';
  if (/dividend/.test(title)) return 'dividend';
  if (/rights/.test(title)) return 'rights';
  return 'action';
}
