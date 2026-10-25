/** How a stock traded around one results filing, from the release's daily closes (the Rotation page's price history). */

export const RUN_UP = 20;

export interface Reaction {
  /** Close-to-close over the RUN_UP sessions before the last close the market saw without the result. */
  runUp: number | null;
  /** First session that could trade on the result, against the close before it. */
  day1: number | null;
  /** Latest close against the close before the result. */
  since: number | null;
  /** RUN_UP sessions after the close before the result; null until that many have traded. */
  after: number | null;
  /** Sessions traded since the result, including the first. */
  sessions: number;
  /** Closes from RUN_UP before the result to the latest, divided by the close before it; `at` is that base close's position. */
  path: number[];
  at: number;
}

const change = (to: number, from: number) => Number.isFinite(to) && Number.isFinite(from) && from > 0 ? (to / from - 1) * 100 : null;

/** The first session that can react: the filing day itself before or during market hours, the next session otherwise. */
export function reactionIndex(dates: readonly string[], filingDay: string, timing?: string | null): number {
  const sameDay = timing === 'Before' || timing === 'During';
  let low = 0, high = dates.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (sameDay ? dates[mid] < filingDay : dates[mid] <= filingDay) low = mid + 1; else high = mid;
  }
  return low;
}

export function reaction(dates: readonly string[], closes: ArrayLike<number>, filingDay: string, timing?: string | null): Reaction | null {
  const first = reactionIndex(dates, filingDay, timing), base = first - 1;
  if (base < 0 || !Number.isFinite(closes[base])) return null;
  const last = (() => { for (let i = closes.length - 1; i >= first; i--) if (Number.isFinite(closes[i])) return i; return -1; })();
  const from = Math.max(0, base - RUN_UP);
  const path: number[] = [];
  for (let i = from; i <= Math.max(base, last); i++) path.push(Number.isFinite(closes[i]) ? closes[i] / closes[base] : NaN);
  return {
    runUp: base >= RUN_UP ? change(closes[base], closes[base - RUN_UP]) : null,
    day1: first < closes.length ? change(closes[first], closes[base]) : null,
    since: last >= first ? change(closes[last], closes[base]) : null,
    after: base + RUN_UP < closes.length ? change(closes[base + RUN_UP], closes[base]) : null,
    sessions: last >= first ? last - first + 1 : 0,
    path, at: base - from,
  };
}

const MOVE = 3, RUN = 5;

/** One plain sentence: how it went into the result, how it took it, and what happened next. */
export function story(value: Reaction): string {
  const into = value.runUp == null ? null
    : value.runUp >= RUN ? `Ran up ${value.runUp.toFixed(0)}% into results`
    : value.runUp <= -RUN ? `Fell ${Math.abs(value.runUp).toFixed(0)}% into results` : 'Quiet into results';
  const day = value.day1 == null ? null
    : value.day1 >= MOVE ? `rallied ${value.day1.toFixed(1)}% on the day`
    : value.day1 <= -MOVE ? `sold off ${Math.abs(value.day1).toFixed(1)}% on the day`
    : 'little changed on the day';
  const after = value.since == null || value.day1 == null || value.sessions < 3 ? null
    : value.since - value.day1 >= RUN ? `then extended to ${signed(value.since)}`
    : value.since - value.day1 <= -RUN ? `then gave back to ${signed(value.since)}` : `${signed(value.since)} since`;
  const parts = [into, day, after].filter(Boolean) as string[];
  if (!parts.length) return 'No trading since the result yet';
  const text = parts.join(', ');
  return text[0].toUpperCase() + text.slice(1);
}

const signed = (value: number) => `${value > 0 ? '+' : ''}${value.toFixed(1)}%`;
