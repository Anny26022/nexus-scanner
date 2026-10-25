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
  /** Average daily value traded (₹ crore) over the window matching each period. */
  traded: Record<Period, number | null>;
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
  rupeeVolumeCrore?: number | null;
  metrics?: Record<string, number | null>;
}

const SESSIONS: Record<Period, number> = {d1: 1, w1: 5, m1: 21, m3: 63, y1: 252};

/** Average daily value traded over the window, or the longest shorter window a recent listing has. */
const turnover = (m: Record<string, number | null>, window: 20 | 50 | 100) =>
  [100, 50, 30, 20].filter(days => days <= window).map(days => finite(m[`turnover${days}`])).find(value => value != null) ?? null;

/** The period's return; a stock listed more recently than the period uses its longest available return instead. */
function periodReturn(m: Record<string, number | null>, period: Exclude<Period, 'd1'>): number | null {
  const own = finite(m[`return${SESSIONS[period]}`]);
  if (own != null) return own;
  const sessions = finite(m.historySessions);
  if (sessions == null || sessions >= SESSIONS[period]) return null;
  for (const window of [63, 21, 5]) if (window < SESSIONS[period] && window <= sessions && finite(m[`return${window}`]) != null) return finite(m[`return${window}`]);
  return null;
}

export function pulseRow(stock: PulseSource): PulseRow {
  const m = stock.metrics ?? {};
  return {
    symbol: stock.symbol, name: stock.name, sector: stock.sector || 'Unclassified', industry: stock.industry || 'Unclassified',
    returns: {d1: finite(stock.changePct), w1: periodReturn(m, 'w1'), m1: periodReturn(m, 'm1'), m3: periodReturn(m, 'm3'), y1: periodReturn(m, 'y1')},
    traded: {d1: finite(stock.rupeeVolumeCrore), w1: turnover(m, 20), m1: turnover(m, 20), m3: turnover(m, 50), y1: turnover(m, 100)},
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

export type PocketLevel = 'theme' | 'industry' | 'subIndustry';
export const POCKET_LEVEL: Record<PocketLevel, string> = {theme: 'Theme', industry: 'Industry', subIndustry: 'Niche'};

export interface ThemeFlow {
  name: string;
  level: PocketLevel;
  /** Move weighted by value traded: where the money actually went, not the typical member. */
  flow: number;
  /** Combined average daily value traded, ₹ crore. */
  traded: number;
  members: number;
  /** Members up 5% or more over the period (2% for one day). */
  movers: number;
  leaders: {symbol: string; move: number}[];
  cohort: boolean;
}

export const COHORTS = new Set(['IPO / Young Bases']);
/** A pocket needs a few traded names, real money, and more than one stock carrying it. */
const MIN_MEMBERS = 4, MIN_TRADED_CR = 50, MAX_SINGLE_SHARE = 0.85;
/** A pocket that mostly repeats one already listed (by value traded) is left out. */
const MAX_OVERLAP = 0.6;
// Corporate actions and thin listings can print absurd returns; they must not steer a pocket.
const clip = (value: number) => Math.max(-90, Math.min(300, value));

function labelsAt(row: PulseRow, level: PocketLevel, taxonomy?: ThemeClassification): string[] {
  if (level === 'theme') return groupsOf(row, 'theme', taxonomy).filter(name => name !== 'Unclassified');
  const label = level === 'industry' ? row.industry : taxonomy?.records[row.symbol]?.subIndustry;
  return label && label !== 'Unclassified' && !/^(miscellaneous|others?|trading|diversified)$/i.test(label) ? [label] : [];
}

/**
 * Money pockets: themes, industries and niches ranked together by their value-weighted move, each naming
 * the stocks that drove it. A pocket that mostly repeats a higher-ranked one is dropped; cohorts are kept apart.
 */
export function themeFlows(rows: PulseRow[], period: Period, taxonomy?: ThemeClassification, direction: 1 | -1 = 1): ThemeFlow[] {
  type Member = {symbol: string; move: number; weight: number; traded: number};
  const groups = new Map<string, {name: string; level: PocketLevel; members: Member[]}>();
  for (const row of rows) {
    const move = row.returns[period], traded = row.traded[period];
    if (move == null || traded == null || traded <= 0) continue;
    for (const level of ['theme', 'industry', 'subIndustry'] as const) for (const name of labelsAt(row, level, taxonomy)) {
      const key = `${level}:${name}`;
      const group = groups.get(key) ?? groups.set(key, {name, level, members: []}).get(key)!;
      group.members.push({symbol: row.symbol, move, weight: clip(move), traded});
    }
  }
  const threshold = period === 'd1' ? 2 : 5;
  const pockets = [...groups.values()].flatMap(({name, level, members}) => {
    const traded = members.reduce((sum, member) => sum + member.traded, 0);
    const cohort = level === 'theme' && COHORTS.has(name);
    if (!cohort && (members.length < MIN_MEMBERS || traded < MIN_TRADED_CR
        || Math.max(...members.map(member => member.traded)) / traded > MAX_SINGLE_SHARE)) return [];
    const flow = members.reduce((sum, member) => sum + member.weight * member.traded, 0) / traded;
    return [{name, level, flow, traded, members, cohort}];
  }).sort((a, b) => direction * (b.flow - a.flow) || a.name.localeCompare(b.name));
  const taken = new Map<string, number>();
  const result: ThemeFlow[] = [];
  for (const pocket of pockets) {
    const repeated = pocket.members.reduce((sum, member) => sum + (taken.has(member.symbol) ? member.traded : 0), 0) / pocket.traded;
    if (!pocket.cohort && repeated >= MAX_OVERLAP) continue;
    if (!pocket.cohort) for (const member of pocket.members) taken.set(member.symbol, member.traded);
    const leaders = [...pocket.members].sort((a, b) => direction * (b.weight * b.traded - a.weight * a.traded)).slice(0, 3)
      .map(({symbol, move}) => ({symbol, move}));
    result.push({name: pocket.name, level: pocket.level, flow: pocket.flow, traded: pocket.traded, members: pocket.members.length,
      movers: pocket.members.filter(member => direction > 0 ? member.move >= threshold : member.move <= -threshold).length, leaders, cohort: pocket.cohort});
  }
  return result;
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
