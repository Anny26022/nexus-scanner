import { copyFormats, type CopyGroup } from '../utils/copyResults';
import {classificationLabels, type ClassificationRecord} from '../data/classification';
import { getIpoJson } from './gzipJson';
import { DataUnavailableError } from './dataErrors';

/** Quarterly results history: a small index in the app, quarter files in object storage. */
const EARNINGS_INDEX_URL = '/data/results/index.json';
const HEATMAP_INDEX_URL = '/data/heatmap/index.json';

export const QUALITY_ORDER = ['Excellent', 'Great', 'Good', 'Ok', 'Weak'] as const;
export type Quality = typeof QUALITY_ORDER[number];

interface FileRef { sha256: string; url: string; count: number }
export interface EarningsIndex {
  version: 1;
  quarters: Record<string, {checkedAt: string; published: FileRef; upcoming: FileRef}>;
}

export interface HeatmapMarketRef extends FileRef {
  checkedAt: string;
  activeQuarter: string;
}

export interface HeatmapIndex {
  version: 1;
  markets: Record<string, HeatmapMarketRef>;
}

/** One company's filing as published by the provider; every field may be missing. */
export interface EarningsRecord {
  symbol: string;
  company_name?: string | null;
  filing_day: string;
  period_end?: string | null;
  quarter_label?: string | null;
  isUpcoming: boolean;
  timing?: string | null;
  quality?: string | null;
  verdict?: string | null;
  cap_type?: string | null;
  market_cap?: number | null;
  sector?: string | null;
  industry?: string | null;
  index_membership?: string[] | null;
  revenue?: number | null;
  revenue_yoy?: number | null;
  revenue_qoq?: number | null;
  operating_profit?: number | null;
  opm?: number | null;
  net_income?: number | null;
  pat_yoy?: number | null;
  pat_qoq?: number | null;
  eps?: number | null;
  eps_yoy?: number | null;
  eps_qoq?: number | null;
  post_earnings_gap_pct?: number | null;
  post_earnings_first_day_pct?: number | null;
  post_earnings_pct?: number | null;
  gap_status_label?: string | null;
  d1_candle_label?: string | null;
  concall_at?: string | null;
  concall_sentiment?: string | null;
  concall_tone?: string | null;
  concall_guide_growth_dir?: string | null;
  concall_guide_growth_txt?: string | null;
  concall_guide_margin_dir?: string | null;
  concall_guide_margin_txt?: string | null;
  concall_guide_capex_txt?: string | null;
  target_raises_7d?: number | null;
  attachment_url?: string | null;
  cmp?: number | null;
}

export async function getEarningsIndex(): Promise<EarningsIndex> {
  const response = await fetch(EARNINGS_INDEX_URL, {cache: 'no-cache'});
  if (!response.ok) throw new DataUnavailableError('Earnings history has not been published yet.', 'not_published');
  const index = await response.json().catch(() => null) as EarningsIndex | null;
  if (!index || index.version !== 1 || typeof index.quarters !== 'object') {
    throw new DataUnavailableError('Earnings history has not been published yet.', 'not_published');
  }
  return index;
}

export async function getHeatmapIndex(): Promise<HeatmapIndex> {
  const response = await fetch(HEATMAP_INDEX_URL, {cache: 'no-cache'});
  if (!response.ok) throw new DataUnavailableError('Earnings heatmap has not been published yet.', 'not_published');
  const index = await response.json().catch(() => null) as HeatmapIndex | null;
  if (!index || index.version !== 1 || typeof index.markets !== 'object') {
    throw new DataUnavailableError('Earnings heatmap has not been published yet.', 'not_published');
  }
  return index;
}

/** One market's active heatmap records from object storage. */
export async function getHeatmapFile(ref: FileRef): Promise<EarningsRecord[]> {
  if (!/^https:\/\/[^/]+\/objects\/[a-f0-9]{64}\.json\.gz$/.test(ref.url)) throw new Error('Invalid heatmap file reference');
  const payload = await getIpoJson<{schemaVersion: number; market: string; activeQuarter: string; records: EarningsRecord[]}>(
    ref.url,
    'Earnings heatmap data'
  );
  if (payload.schemaVersion !== 1 || !Array.isArray(payload.records)) throw new Error('Unexpected heatmap file');
  return payload.records.map(cleanRecord);
}

/** One calendar quarter's published or upcoming records. Files are content-addressed, so they never change. */
export async function getEarningsFile(ref: FileRef): Promise<EarningsRecord[]> {
  if (!/^https:\/\/[^/]+\/objects\/[a-f0-9]{64}\.json\.gz$/.test(ref.url)) throw new Error('Invalid earnings file reference');
  const payload = await getIpoJson<{schemaVersion: number; records: EarningsRecord[]}>(ref.url, 'Earnings data');
  if (payload.schemaVersion !== 1 || !Array.isArray(payload.records)) throw new Error('Unexpected earnings file');
  return payload.records.map(cleanRecord);
}

/** Some provider text arrives as UTF-8 read as Latin-1 ("â\u0086\u0091" for "↑"); undo that when it is reversible. */
export function repairText(value: string | null | undefined): string | null {
  if (!value) return null;
  if (!/[Â-ô][\u0080-¿]/.test(value)) return value;
  try {
    const bytes = Uint8Array.from(value, character => {
      const code = character.charCodeAt(0);
      if (code > 0xff) throw new Error('not Latin-1');
      return code;
    });
    return new TextDecoder('utf-8', {fatal: true}).decode(bytes);
  } catch {
    return value;
  }
}

const finite = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : null;

function cleanRecord(record: EarningsRecord): EarningsRecord {
  const text = (key: keyof EarningsRecord) => repairText(record[key] as string | null | undefined);
  return {
    ...record,
    company_name: text('company_name'),
    concall_guide_growth_txt: text('concall_guide_growth_txt'),
    concall_guide_margin_txt: text('concall_guide_margin_txt'),
    concall_guide_capex_txt: text('concall_guide_capex_txt'),
    ...Object.fromEntries((['revenue', 'revenue_yoy', 'revenue_qoq', 'operating_profit', 'opm', 'net_income', 'pat_yoy', 'pat_qoq',
      'eps', 'eps_yoy', 'eps_qoq', 'post_earnings_gap_pct', 'post_earnings_first_day_pct', 'post_earnings_pct', 'market_cap', 'cmp'] as const)
      .map(key => [key, finite(record[key])])),
  };
}

export interface Season {
  /** Fiscal period end, e.g. 2026-09-30. */
  periodEnd: string;
  label: string;
  /** Calendar quarters whose filings can report this period: the one after the period and the next. */
  quarters: string[];
  checkedAt: string;
  reported: number;
}

const quarterOf = (date: string) => `${date.slice(0, 4)}-Q${Math.floor((Number(date.slice(5, 7)) - 1) / 3) + 1}`;
const nextQuarter = (label: string) => {
  const year = Number(label.slice(0, 4)), quarter = Number(label.slice(-1));
  return quarter === 4 ? `${year + 1}-Q1` : `${year}-Q${quarter + 1}`;
};
const periodEndBefore = (quarter: string) => {
  const year = Number(quarter.slice(0, 4)), q = Number(quarter.slice(-1));
  return ['', `${year - 1}-12-31`, `${year}-03-31`, `${year}-06-30`, `${year}-09-30`][q];
};
export const periodLabel = (periodEnd: string) => new Date(`${periodEnd}T00:00:00Z`)
  .toLocaleDateString('en-IN', {month: 'short', year: 'numeric', timeZone: 'UTC'});

/** Result seasons, newest first: each fiscal quarter is reported in the calendar quarter after it ends. */
export function seasons(index: EarningsIndex): Season[] {
  return Object.keys(index.quarters).sort().reverse()
    .filter(quarter => index.quarters[quarter].published.count > 0)
    .map(quarter => {
      const periodEnd = periodEndBefore(quarter);
      const files = [quarter, nextQuarter(quarter)].filter(label => index.quarters[label]);
      return {periodEnd, label: periodLabel(periodEnd), quarters: files, checkedAt: index.quarters[quarter].checkedAt,
        reported: files.reduce((sum, label) => sum + index.quarters[label].published.count, 0)};
    });
}

/** The calendar quarter holding today's and later scheduled filings. */
export const upcomingQuarters = (index: EarningsIndex, today: string) =>
  Object.keys(index.quarters).filter(quarter => quarter >= quarterOf(today) && index.quarters[quarter].upcoming.count > 0).sort();

export const qualityRank = (quality: string | null | undefined) => {
  const rank = QUALITY_ORDER.indexOf(quality as Quality);
  return rank === -1 ? QUALITY_ORDER.length : rank;
};

export function median(values: readonly (number | null | undefined)[]): number | null {
  const sorted = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export interface SeasonSummary {
  reported: number;
  medianRevenueYoy: number | null;
  medianPatYoy: number | null;
  /** Share of companies growing both revenue and profit year on year. */
  bothGrowing: number | null;
  quality: Record<string, number>;
  verdicts: Record<string, number>;
  medianReaction: number | null;
}

export function summarize(records: readonly EarningsRecord[]): SeasonSummary {
  const counted = records.filter(record => record.revenue_yoy != null && record.pat_yoy != null);
  const tally = (key: 'quality' | 'verdict') => records.reduce<Record<string, number>>((out, record) => {
    const value = record[key];
    if (value) out[value] = (out[value] ?? 0) + 1;
    return out;
  }, {});
  return {
    reported: records.length,
    medianRevenueYoy: median(records.map(record => record.revenue_yoy)),
    medianPatYoy: median(records.map(record => record.pat_yoy)),
    bothGrowing: counted.length ? counted.filter(record => record.revenue_yoy! > 0 && record.pat_yoy! > 0).length / counted.length * 100 : null,
    quality: tally('quality'),
    verdicts: tally('verdict'),
    medianReaction: median(records.map(record => record.post_earnings_pct)),
  };
}

/** Records for one fiscal period from the season's files, newest filings first, one per company. */
export function seasonRecords(files: readonly EarningsRecord[][], periodEnd: string): EarningsRecord[] {
  const bySymbol = new Map<string, EarningsRecord>();
  for (const record of files.flat()) {
    if (record.period_end !== periodEnd) continue;
    const seen = bySymbol.get(record.symbol);
    if (!seen || record.filing_day > seen.filing_day) bySymbol.set(record.symbol, record);
  }
  return [...bySymbol.values()].sort((a, b) => b.filing_day.localeCompare(a.filing_day) || a.symbol.localeCompare(b.symbol));
}

/** Scheduled filings from today on, grouped by date. */
export function upcomingByDate(records: readonly EarningsRecord[], today: string): [string, EarningsRecord[]][] {
  const groups = new Map<string, EarningsRecord[]>();
  for (const record of records) {
    if (record.filing_day < today) continue;
    groups.set(record.filing_day, [...(groups.get(record.filing_day) ?? []), record]);
  }
  return [...groups].sort(([a], [b]) => a.localeCompare(b))
    .map(([date, rows]) => [date, rows.sort((a, b) => (b.market_cap ?? 0) - (a.market_cap ?? 0))]);
}

/** A company's results across every loaded season, newest period first. */
export function companyHistory(files: readonly EarningsRecord[][], symbol: string): EarningsRecord[] {
  const byPeriod = new Map<string, EarningsRecord>();
  for (const record of files.flat()) {
    if (record.symbol !== symbol || record.isUpcoming || !record.period_end) continue;
    const seen = byPeriod.get(record.period_end);
    if (!seen || record.filing_day > seen.filing_day) byPeriod.set(record.period_end, record);
  }
  return [...byPeriod.values()].sort((a, b) => b.period_end!.localeCompare(a.period_end!));
}

/** Where a company sits in Nexus's own classification, joined by symbol (from the chart directory and theme file). */
export interface Classification extends ClassificationRecord {
  sector?: string | null; industry?: string | null; subIndustry?: string | null;
  theme?: string | null; block?: string | null; macro?: string | null;
}
export type GroupBy = Exclude<CopyGroup, 'symbols'>;
/** The screener's own names for each level. */
export const GROUP_LABEL = Object.fromEntries(copyFormats.map(({value, label}) => [value, label])) as Record<GroupBy, string>;
/** Levels that come from the theme file rather than the chart directory. */
export const THEME_LEVELS: ReadonlySet<string> = new Set<GroupBy>(['subIndustry', 'theme', 'block', 'macro', 'cohort', 'aggregate']);
export const UNCLASSIFIED = 'Unclassified';

export interface EarningsGroup {
  label: string;
  records: EarningsRecord[];
  medianRevenueYoy: number | null;
  medianPatYoy: number | null;
  medianEpsYoy: number | null;
  medianReaction: number | null;
  quality: Record<string, number>;
  /** Share graded Excellent or Great. */
  strong: number;
}

/**
 * Results grouped like the screener's grouped results; unclassified companies form the last group.
 */
export function groupRecords(records: readonly EarningsRecord[], by: GroupBy,
  classify: (symbol: string) => Classification | undefined): EarningsGroup[] {
  const groups = new Map<string, EarningsRecord[]>();
  for (const record of records) {
    const known = classify(record.symbol);
    const labels = classificationLabels(known ?? {}, known, by);
    for (const label of labels.length ? labels : [UNCLASSIFIED]) {
      const rows = groups.get(label) ?? [];
      if (!rows.some(row => row.symbol === record.symbol)) rows.push(record);
      groups.set(label, rows);
    }
  }
  return [...groups].map(([label, rows]) => {
    const quality = summarize(rows).quality;
    return {label, records: rows, quality, medianRevenueYoy: median(rows.map(row => row.revenue_yoy)),
      medianPatYoy: median(rows.map(row => row.pat_yoy)), medianEpsYoy: median(rows.map(row => row.eps_yoy)),
      medianReaction: median(rows.map(row => row.post_earnings_pct)),
      strong: rows.length ? ((quality.Excellent ?? 0) + (quality.Great ?? 0)) / rows.length * 100 : 0};
  }).sort((a, b) => Number(a.label === UNCLASSIFIED) - Number(b.label === UNCLASSIFIED)
    || b.records.length - a.records.length || a.label.localeCompare(b.label));
}
