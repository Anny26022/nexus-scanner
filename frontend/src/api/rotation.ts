import { WARM_UP, rotation } from '../utils/rrg';

/** Calendars the history is published on: one close per session, ISO week and month. */
export type Frame = 'D' | 'W' | 'M';
/** A published index (codes match the stock universes) or EW, the equal-weight market built like the groups. */
export type BenchmarkCode = 'N50' | 'N100' | 'N500' | 'MID150' | 'SML250' | 'MS400' | 'TOTAL' | 'EW';
export type RotationShardName = 'core' | 'rest' | 'groups';
export const LEVELS = ['sector', 'industry', 'subIndustry', 'theme', 'block', 'macro'] as const;
export type Level = typeof LEVELS[number];
/** Delta-coded natural logs: [offset into the calendar, first value, deltas…], scaled by `scale`. */
type Coded = [number, ...(number | null)[]];

export interface RotationIndex {
  schemaVersion: 1;
  asOfDate: string;
  scale: number;
  frames: Record<Frame, string[]>;
  /** EW (equal-weight market) is present when groups were built; older objects may lack it. */
  benchmarks: Partial<Record<BenchmarkCode, {name: string; series: Record<Frame, Coded | null>}>>;
  universes: Record<string, string>;
  stocks: {s: string; n: string; u: string[]; h: 'core' | 'rest'; c?: number; t?: number; b?: string}[];
  groups: {id: string; l: Level; n: string; m: string[]}[];
  shards: Record<RotationShardName, string>;
}
export interface RotationShard {
  schemaVersion: 1;
  asOfDate: string;
  shard: RotationShardName;
  series: Record<Frame, Record<string, Coded>>;
}

export const FRAME_LABEL: Record<Frame, string> = {D: 'Daily', W: 'Weekly', M: 'Monthly'};
export const LEVEL_LABEL: Record<Level, string> = {sector: 'Sectors', industry: 'Industries', subIndustry: 'Sub-industries',
  theme: 'Themes', block: 'Thematic blocks', macro: 'Macro pillars'};
/** Replay windows per calendar, in periods. `null` means as far back as the history allows. */
export const RANGES: Record<Frame, [string, number | null][]> = {
  D: [['1M', 21], ['3M', 63], ['6M', 126], ['1Y', 250]],
  W: [['3M', 13], ['6M', 26], ['1Y', 52], ['2Y', 104], ['5Y', 260]],
  M: [['1Y', 12], ['3Y', 36], ['5Y', 60], ['Max', null]],
};
export const DEFAULT_RANGE: Record<Frame, string> = {D: '3M', W: '6M', M: '3Y'};
export const DEFAULT_TAIL: Record<Frame, number> = {D: 8, W: 5, M: 4};

/** A universe is either stocks (an index, everything, or the watchlist), a classification level, or one group's members. */
export type Universe =
  | {kind: 'stocks'; code: string}
  | {kind: 'level'; level: Level}
  | {kind: 'members'; group: string};

export interface RotationItem {
  id: string;
  label: string;
  /** Company name for stocks, member count for groups. */
  detail: string;
  kind: 'stock' | 'group';
  shard: RotationShardName;
  members?: string[];
  /** Liquidity fields for stocks, as published on the screener rows. */
  cap?: number;
  turnover?: number;
  band?: string;
}

export function decode(coded: Coded | null | undefined, length: number, scale: number): Float64Array {
  const values = new Float64Array(length).fill(NaN);
  if (!coded || coded.length < 2) return values;
  let level = 0;
  for (let i = 1; i < coded.length; i++) {
    const value = coded[i];
    if (value === null) continue;
    level = i === 1 ? value : level + value;
    const at = coded[0] + i - 1;
    if (at < length) values[at] = Math.exp(level / scale);
  }
  return values;
}

/** Classification labels arrive in mixed case; shouting ones read as title case, keeping acronyms (FMCG, IT, PSU). */
export const displayLabel = (label: string) => label !== label.toUpperCase() ? label
  : label.replace(/[A-Z][A-Z]+/g, word => word.length <= 3 || !/[AEIOU]/.test(word) ? word : word[0] + word.slice(1).toLowerCase());

export function itemsFor(index: RotationIndex, universe: Universe, watchlist: ReadonlySet<string>): RotationItem[] {
  const stock = (row: RotationIndex['stocks'][number]): RotationItem =>
    ({id: row.s, label: row.s, detail: row.n, kind: 'stock', shard: row.h, cap: row.c, turnover: row.t, band: row.b});
  if (universe.kind === 'stocks') {
    const rows = universe.code === 'ALL' ? index.stocks
      : universe.code === 'WATCH' ? index.stocks.filter(row => watchlist.has(row.s))
      : index.stocks.filter(row => row.u.includes(universe.code));
    return rows.map(stock);
  }
  if (universe.kind === 'level') {
    return index.groups.filter(group => group.l === universe.level)
      .map(group => ({id: group.id, label: displayLabel(group.n), detail: `${group.m.length} stocks`, kind: 'group', shard: 'groups', members: group.m}));
  }
  const members = new Set(index.groups.find(group => group.id === universe.group)?.m ?? []);
  return index.stocks.filter(row => members.has(row.s)).map(stock);
}

/** Usable replay length for a range: the calendar minus the warm-up the averages need. */
export function rangeLength(index: RotationIndex, frame: Frame, range: string): number {
  const available = index.frames[frame].length - WARM_UP - 1;
  const wanted = RANGES[frame].find(([label]) => label === range)?.[1] ?? available;
  return Math.max(2, Math.min(available, wanted));
}

export interface Track { item: RotationItem; ratio: Float64Array; momentum: Float64Array }

/** A published index, or a group composite (for a group's own members). */
export type Benchmark = BenchmarkCode | {group: string};

/** RS-Ratio / RS-Momentum for every item on one calendar against one benchmark. */
export function tracks(index: RotationIndex, items: RotationItem[], shards: Partial<Record<RotationShardName, RotationShard>>,
  frame: Frame, benchmark: Benchmark): Track[] {
  const length = index.frames[frame].length;
  const base = benchmarkCloses(index, frame, benchmark, shards);
  return items.flatMap(item => {
    const coded = shards[item.shard]?.series[frame][item.id];
    if (!coded) return [];
    const {ratio, momentum} = rotation(decode(coded, length, index.scale), base);
    return [{item, ratio, momentum}];
  });
}

export function benchmarkCloses(index: RotationIndex, frame: Frame, benchmark: Benchmark,
  shards: Partial<Record<RotationShardName, RotationShard>> = {}): Float64Array {
  const coded = typeof benchmark === 'string' ? index.benchmarks[benchmark]?.series[frame] : shards.groups?.series[frame][benchmark.group];
  return decode(coded, index.frames[frame].length, index.scale);
}

/** How far an item travelled over its trail, with each axis measured against its own spread. */
export function travel(track: Track, cursor: number, tail: number, half: {x: number; y: number}): number {
  const now = {x: track.ratio[cursor], y: track.momentum[cursor]};
  let from = Math.max(0, cursor - tail);
  while (from < cursor && !(Number.isFinite(track.ratio[from]) && Number.isFinite(track.momentum[from]))) from++;
  if (from === cursor || !Number.isFinite(now.x) || !Number.isFinite(now.y)) return 0;
  return Math.hypot((now.x - track.ratio[from]) / half.x, (now.y - track.momentum[from]) / half.y);
}
