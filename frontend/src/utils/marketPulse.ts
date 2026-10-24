/** Per-stock market pulse: trend stages, new highs and lows, and group returns, from one published snapshot. */
import type { ThemeClassification } from './copyResults';

export type Stage = 1 | 2 | 3 | 4;
export const STAGES: Stage[] = [1, 2, 3, 4];
export const STAGE_LABEL: Record<Stage, string> = {1: 'Basing', 2: 'Advancing', 3: 'Topping', 4: 'Declining'};
export const STAGE_HINT: Record<Stage, string> = {
  1: 'Above the 150-day average while the 50-day is still below it',
  2: 'Above the 150-day average with the 50-day above it',
  3: 'Below the 150-day average while the 50-day is still above it',
  4: 'Below the 150-day average with the 50-day below it',
};

export type Period = 'd1' | 'w1' | 'm1' | 'm3' | 'y1';
export const PERIODS: [Period, string][] = [['d1', '1D'], ['w1', '1W'], ['m1', '1M'], ['m3', '3M'], ['y1', '1Y']];

export interface PulseRow {
  symbol: string;
  name: string;
  sector: string;
  industry: string;
  returns: Record<Period, number | null>;
  newHigh: boolean;
  newLow: boolean;
  stage: Stage | null;
  /** Whether the close is above each simple moving average; null without one. */
  above: Record<Average, boolean | null>;
}

export type Average = 10 | 20 | 50 | 200;
export const AVERAGES: Average[] = [10, 20, 50, 200];

const finite = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;

/** A Weinstein-style stage from price against the 150-day (30-week) average and the 50-day's side of it. */
export function stageOf(close: unknown, sma50: unknown, sma150: unknown): Stage | null {
  const price = finite(close), fast = finite(sma50), slow = finite(sma150);
  if (price == null || fast == null || slow == null) return null;
  const above = price > slow, rising = fast > slow;
  return above ? (rising ? 2 : 1) : (rising ? 3 : 4);
}

export interface PulseSource {
  symbol: string; name: string; sector: string; industry: string; close: number; changePct: number;
  metrics?: Record<string, number | null>;
}

export function pulseRow(stock: PulseSource): PulseRow {
  const m = stock.metrics ?? {};
  return {
    symbol: stock.symbol, name: stock.name, sector: stock.sector || 'Unclassified', industry: stock.industry || 'Unclassified',
    returns: {d1: finite(stock.changePct), w1: finite(m.return5), m1: finite(m.return21), m3: finite(m.return63), y1: finite(m.return252)},
    newHigh: m.NEW_HIGH === 1, newLow: m.NEW_LOW === 1,
    stage: stageOf(stock.close, m.sma50, m.sma150),
    above: Object.fromEntries(AVERAGES.map(period => {
      const average = finite(m[`sma${period}`]), close = finite(stock.close);
      return [period, average == null || close == null ? null : close > average];
    })) as Record<Average, boolean | null>,
  };
}

export type Grouping = 'sector' | 'industry' | 'theme';
export const GROUPINGS: [Grouping, string][] = [['sector', 'Sector'], ['industry', 'Industry'], ['theme', 'Theme']];

/** The groups a stock belongs to; a stock can sit in its primary theme and curated themes at once. */
export function groupsOf(row: PulseRow, grouping: Grouping, taxonomy?: ThemeClassification): string[] {
  if (grouping !== 'theme') return [row[grouping]];
  const record = taxonomy?.records[row.symbol] as (ThemeClassification['records'][string] & {memberships?: Record<string, string>}) | undefined;
  const themes = new Set([record?.theme, ...Object.keys(record?.memberships ?? {})].filter((name): name is string => Boolean(name?.trim())));
  return themes.size ? [...themes] : ['Unclassified'];
}

export interface GroupShare { name: string; count: number; share: number; symbols: string[]; children: number }

/** Matching stocks by group, largest first; share is of all matches, children counts distinct industries in a sector. */
export function breakdown(rows: PulseRow[], grouping: Grouping, taxonomy?: ThemeClassification): GroupShare[] {
  const groups = new Map<string, {symbols: string[]; industries: Set<string>}>();
  for (const row of rows) for (const name of groupsOf(row, grouping, taxonomy)) {
    const entry = groups.get(name) ?? {symbols: [], industries: new Set()};
    entry.symbols.push(row.symbol);
    entry.industries.add(row.industry);
    groups.set(name, entry);
  }
  return [...groups].map(([name, {symbols, industries}]) => ({
    name, count: symbols.length, share: rows.length ? symbols.length / rows.length : 0, symbols,
    children: grouping === 'sector' ? industries.size : 0,
  })).sort((a, b) => b.count - a.count || (a.name === 'Unclassified' ? 1 : b.name === 'Unclassified' ? -1 : a.name.localeCompare(b.name)));
}

export interface ThemeMove { name: string; median: number; advancing: number; members: number }

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b), mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/** Each theme's median return over the period, strongest first; themes need three priced members. */
export function themeMoves(rows: PulseRow[], period: Period, taxonomy?: ThemeClassification, minimum = 3): ThemeMove[] {
  const themes = new Map<string, number[]>();
  for (const row of rows) {
    const value = row.returns[period];
    if (value == null) continue;
    for (const name of groupsOf(row, 'theme', taxonomy)) {
      if (name === 'Unclassified') continue;
      themes.set(name, [...(themes.get(name) ?? []), value]);
    }
  }
  return [...themes].filter(([, values]) => values.length >= minimum)
    .map(([name, values]) => ({name, median: median(values), advancing: values.filter(value => value > 0).length / values.length, members: values.length}))
    .sort((a, b) => b.median - a.median || a.name.localeCompare(b.name));
}

export function stageCounts(rows: PulseRow[]): Record<Stage, number> {
  const counts: Record<Stage, number> = {1: 0, 2: 0, 3: 0, 4: 0};
  for (const row of rows) if (row.stage) counts[row.stage]++;
  return counts;
}

/** Share of stocks with an average that close above it, per average. */
export function participation(rows: PulseRow[]): Record<Average, number | null> {
  return Object.fromEntries(AVERAGES.map(period => {
    const known = rows.filter(row => row.above[period] != null);
    return [period, known.length ? known.filter(row => row.above[period]).length / known.length : null];
  })) as Record<Average, number | null>;
}
