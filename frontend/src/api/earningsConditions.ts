/**
 * The Earnings filters and scans, decided from each row's published `earnings` object (nexus-scanner's
 * frontend/earnings_signals.py, India and US alike). Growth is always year on year against the same quarter, since
 * Indian quarters are seasonal; growth off a loss is left out (a turnaround is its own test).
 */
import type { EarningsFacts, EarningsQuarter, EarningsReaction } from '../types/screener';

type Truth = boolean | null;
type Row = {earnings?: EarningsFacts | null; asOfDate: string | null};
type Predicate = (row: Row) => Truth;

export const EARNINGS_KINDS = ['RESULTS_DUE', 'EARNINGS_GAP', 'EARNINGS_MOVE', 'EPS_BLOWOUT', 'EPS_ACCELERATION', 'TURNAROUND',
  'QUARTER_STREAK'] as const;
const KINDS: ReadonlySet<string> = new Set(EARNINGS_KINDS);
export const isEarningsCondition = (id: string) => KINDS.has(id);

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const num = (value: unknown) => Number(value);
const rising = (values: number[]) => values.every((value, index) => index === 0 || value > values[index - 1]);

/** Today in India, the day a results calendar is read against. */
export function istToday(now = Date.now()): string {
  return new Date(now + 330 * 60_000).toISOString().slice(0, 10);
}

const NEW_YORK_DAY = new Intl.DateTimeFormat('en-CA', {timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit'});
/** Today on the market's own calendar: New York for the US snapshot, India otherwise. */
export const marketToday = (market?: string, now = Date.now()) => market === 'us' ? NEW_YORK_DAY.format(now) : istToday(now);

// The published positional orders (nexus-scanner frontend/earnings_signals.py QUARTER_FIELDS and REACTION_FIELDS).
const decodedQuarters = new WeakMap<EarningsFacts, EarningsQuarter[]>();
const decodedReactions = new WeakMap<EarningsFacts, EarningsReaction[]>();
export function quarterList(facts: EarningsFacts): EarningsQuarter[] {
  let quarters = decodedQuarters.get(facts);
  if (!quarters) {
    quarters = (facts.q ?? []).map(([end, sales, eps, pat, npm, np, np0, eps0, basis]) =>
      ({end, sales, eps, pat, npm, np, np0, eps0, epsBasis: basis === 1 ? 'EPS' : 'PAT'}));
    decodedQuarters.set(facts, quarters);
  }
  return quarters;
}
export function reactionList(facts: EarningsFacts): EarningsReaction[] {
  let events = decodedReactions.get(facts);
  if (!events) {
    events = (facts.reaction ?? []).map(([age, gap, move, pos, vsOpen, unfilled]) =>
      ({age: age as number, gap: gap as number, move: move as number, pos, vsOpen, unfilled: unfilled as number}));
    decodedReactions.set(facts, events);
  }
  return events;
}

/** Quarter ends about three months apart (52/53-week fiscal quarters included): no quarter is missing between them. */
const consecutive = (quarters: EarningsQuarter[]) => quarters.every((quarter, index) => {
  if (index === 0) return true;
  const days = (Date.parse(quarter.end) - Date.parse(quarters[index - 1].end)) / 86_400_000;
  return days >= 75 && days <= 105;
});

/** Sessions since the facts were published: a live row is one session on. */
const shift = (row: Row) => row.earnings && row.asOfDate && row.asOfDate > row.earnings.asOf ? 1 : 0;

/** The last `count` consecutive quarters when the latest is fresh enough and none is a one-off tax-credit quarter. */
function recent(facts: EarningsFacts | null | undefined, count: number, maxBehind: number, skipTaxCredit = true): EarningsQuarter[] | null {
  if (!facts?.q || facts.q.length < count || !finite(facts.behind) || facts.behind > maxBehind) return null;
  if (skipTaxCredit && facts.taxCredit) return null;
  const quarters = quarterList(facts).slice(-count);
  return consecutive(quarters) ? quarters : null;
}

/** A results-day reaction within `window` sessions that passes `test`: the results session or the one after. */
function reacted(row: Row, window: number, test: (event: EarningsReaction) => boolean): Truth {
  if (!row.earnings) return null;
  const events = reactionList(row.earnings);
  return events.some(event => event.age + shift(row) <= window && test(event));
}

/** The predicate for an Earnings condition, or null when its parameters are not usable. */
export function earningsPredicate(kind: string, p: Record<string, any>, session: string, now = Date.now(), market?: string): Predicate | null {
  switch (kind) {
    case 'RESULTS_DUE': {
      const ahead = num(p.daysAhead);
      if (!(ahead >= 0 && ahead <= 14)) return null;
      const calendar = marketToday(market, now), today = session > calendar ? session : calendar;
      const last = new Date(Date.parse(`${today}T00:00:00Z`) + ahead * 86_400_000).toISOString().slice(0, 10);
      return row => {
        const facts = row.earnings;
        if (!facts) return null;
        return facts.declared === today || (!!facts.next && facts.next >= today && facts.next <= last);
      };
    }
    case 'EARNINGS_GAP': {
      const window = num(p.window), gap = num(p.minGapPct), close = num(p.minClosePct), hold = p.gapHold === true;
      if (![window, gap, close].every(Number.isFinite)) return null;
      // Held: closed at or above its open (when asked), and no low since has traded back into the gap.
      return row => reacted(row, window, event => event.gap >= gap && event.move >= close
        && (!hold || (finite(event.vsOpen) && event.vsOpen >= 0)) && event.unfilled > 0);
    }
    case 'EARNINGS_MOVE': {
      const window = num(p.window), move = num(p.minMovePct), position = num(p.minClosePos);
      if (![window, move, position].every(Number.isFinite)) return null;
      return row => reacted(row, window, event => event.move >= move && finite(event.pos) && event.pos >= position);
    }
    case 'EPS_BLOWOUT': {
      const window = num(p.window), eps = num(p.minEpsPct), sales = num(p.minSalesPct), pat = num(p.minPatPct);
      const base = num(p.minBaseEps), behind = num(p.maxBehind);
      if (![window, eps, sales, pat, base, behind].every(Number.isFinite)) return null;
      return row => {
        const facts = row.earnings;
        if (!facts) return null;
        const [latest] = recent(facts, 1, behind, false) ?? [];
        // EPS is compared only where the share count did not move (an unrestated split would fake a doubling).
        if (!latest || latest.epsBasis !== 'EPS' || !finite(latest.eps0) || latest.eps0 < base) return false;
        const age = finite(facts.declaredAge) ? facts.declaredAge + shift(row) : null;
        return age != null && age <= window && finite(latest.eps) && latest.eps >= eps
          && finite(latest.sales) && latest.sales >= sales && finite(latest.pat) && latest.pat >= pat;
      };
    }
    case 'EPS_ACCELERATION': {
      const latestEps = num(p.minLatestEpsPct), base = num(p.minYearAgoEps), sales = num(p.minSalesPct), behind = num(p.maxBehind);
      const margin = p.margin === true || p.margin === 'RISING';
      if (![latestEps, base, sales, behind].every(Number.isFinite)) return null;
      return row => {
        if (!row.earnings) return null;
        const quarters = recent(row.earnings, 3, behind);
        if (!quarters) return false;
        const growth = quarters.map(q => q.eps), sale = quarters.map(q => q.sales), npm = quarters.map(q => q.npm);
        if (!growth.every(finite) || !sale.every(finite) || (margin && !npm.every(finite))) return false;
        const latest = quarters[quarters.length - 1];
        // A meaningful base: year-ago EPS of at least `base`, or year-ago profit where EPS was not comparable.
        const based = latest.epsBasis === 'EPS' ? finite(latest.eps0) && latest.eps0 >= base : finite(latest.np0) && latest.np0 > 0;
        return based && growth.every(value => value > 0) && sale.every(value => value > 0 && value >= sales)
          && growth[growth.length - 1] >= latestEps && rising(growth) && (!margin || (rising(sale) && rising(npm as number[])));
      };
    }
    case 'TURNAROUND': {
      const sales = num(p.minSalesPct), behind = num(p.maxBehind);
      if (![sales, behind].every(Number.isFinite)) return null;
      return row => {
        if (!row.earnings) return null;
        const quarters = recent(row.earnings, 3, behind);
        if (!quarters) return false;
        const latest = quarters[quarters.length - 1], profits = quarters.map(q => q.np);
        return finite(latest.np0) && latest.np0 < 0 && profits.every(finite) && (profits[profits.length - 1] as number) > 0
          && rising(profits as number[]) && finite(latest.sales) && latest.sales >= sales;
      };
    }
    case 'QUARTER_STREAK': {
      const count = num(p.quarters);
      if (!['SALES_UP', 'EPS_UP', 'PROFIT_POSITIVE'].includes(p.measure) || !(count >= 1 && count <= 4)) return null;
      return row => {
        if (!row.earnings) return null;
        const quarters = recent(row.earnings, count, 1, false);
        if (!quarters) return false;
        const values = quarters.map(q => p.measure === 'SALES_UP' ? q.sales : p.measure === 'EPS_UP' ? q.eps : q.np);
        return values.every(value => finite(value) && value > 0);
      };
    }
    default:
      return null;
  }
}
