import { useId, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { SlidersHorizontal } from 'lucide-react';
import { screenerApi } from '../api/screenerApi';
import { DataUnavailableError } from '../api/dataErrors';
import { marketRegime } from '../utils/marketOverview';
import {
  AVERAGES, GROUPINGS, PERIODS, STAGES, STAGE_HINT, STAGE_LABEL,
  breakdown, participation, stageCounts, themeFlows,
  type Grouping, type Period, type PulseRow, type ThemeFlow, POCKET_LEVEL,
} from '../utils/marketPulse';
import type { BreadthSession, IndexCard } from '../types/market';
import type { IPORow } from '../types/screener';
import { Button } from './Button';
import '../styles/market.css';

const formatDate = (date: string, withYear = true) => new Date(`${date}T00:00:00`)
  .toLocaleDateString('en-IN', {day: 'numeric', month: 'short', ...(withYear ? {year: 'numeric'} : {})});
const pct = (value: number | null | undefined, digits = 0) => value == null ? '—' : `${value.toFixed(digits)}%`;
const share = (value: number) => `${Math.round(value * 100)}%`;
const count = (value: number | null | undefined) => value == null ? '—' : value.toLocaleString('en-IN');
const signed = (value: number, digits = 2) => `${value > 0 ? '+' : ''}${value.toFixed(digits)}%`;

/** A titled section: the heading sits on the page, the content in one quiet bordered card. */
function Panel({title, aside, children, className = '', bare = false}: {title: string; aside?: ReactNode; children: ReactNode; className?: string; bare?: boolean}) {
  return <section className={`flex min-w-0 flex-col gap-3 ${className}`} aria-label={title}>
    <header className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
      <h2 className="m-0 text-[17px] font-semibold tracking-[-0.015em] text-text">{title}</h2>
      {aside}
    </header>
    {bare ? children : <div className="mkt-card flex min-w-0 flex-col gap-5 p-5 max-md:p-4">{children}</div>}
  </section>;
}

function Segmented<T extends string>({label, value, options, onChange}: {label: string; value: T; options: [T, string][]; onChange: (value: T) => void}) {
  const name = useId();
  return <div className="inline-flex rounded-(--radius-md) bg-field p-0.5" role="radiogroup" aria-label={label}>
    {options.map(([key, text]) => <label key={key}
      className={`relative flex h-7 cursor-pointer items-center rounded-[7px] px-2.5 text-[12px] font-semibold transition ${value === key ? 'bg-surface text-text shadow-(--shadow-control)' : 'text-muted hover:text-text'}`}>
      <input type="radio" name={name} value={key} checked={value === key} onChange={() => onChange(key)}
        className="absolute inset-0 m-0 h-full w-full cursor-pointer appearance-none rounded-[inherit] bg-transparent" />
      {text}
    </label>)}
  </div>;
}

/** One card per index: price, then the day's change in points and percent. */
function IndexCards({indices}: {indices: IndexCard[]}) {
  return <Panel title="Indexes" bare>
    <div className="mkt-indexes" aria-label="Key indices">
      {indices.map(index => {
        const positive = (index.changePct ?? 0) >= 0;
        const points = index.changePct == null ? null : index.close - index.close / (1 + index.changePct / 100);
        return <div key={index.symbol} className="mkt-card flex min-w-0 flex-col gap-2 px-4 py-3.5" data-tone={positive ? 'up' : 'down'}
          title={`${index.name}: ${index.series.length} sessions to ${formatDate(index.date)}`}>
          <span className="truncate text-[13px] font-semibold text-text">{index.name}</span>
          <span className="text-[20px] font-semibold tabular-nums tracking-[-0.02em] text-text">{index.close.toLocaleString('en-IN', {maximumFractionDigits: 2})}</span>
          <span className="flex gap-2.5 text-[12.5px] font-semibold tabular-nums" style={{color: 'var(--tone)'}}>
            {points != null && <span>{points > 0 ? '+' : ''}{points.toLocaleString('en-IN', {maximumFractionDigits: 2})}</span>}
            <span>{index.changePct == null ? '—' : signed(index.changePct)}</span>
          </span>
        </div>;
      })}
    </div>
  </Panel>;
}

/** Two counts as one bar: the left side's share is the headline. */
function Versus({title, left, right, leftLabel, rightLabel}: {title: string; left: number; right: number; leftLabel: string; rightLabel: string}) {
  const total = left + right, ratio = total ? left / total : 0;
  return <div className="flex flex-col gap-2">
    <div className="flex items-baseline justify-between gap-3">
      <h3 className="m-0 text-[15px] font-semibold text-text">{title}</h3>
      <span className="text-[18px] font-semibold tabular-nums tracking-[-0.02em]" data-tone={ratio >= 0.5 ? 'up' : 'down'} style={{color: 'var(--tone)'}}>{total ? share(ratio) : '—'}</span>
    </div>
    <div className="h-2 overflow-hidden rounded-full bg-field" role="img" aria-label={`${left} ${leftLabel}, ${right} ${rightLabel}`}
      data-tone={ratio >= 0.5 ? 'up' : 'down'}>
      <span className="block h-full rounded-full" style={{width: `${ratio * 100}%`, background: 'var(--tone)'}} />
    </div>
    <div className="flex justify-between text-[13px] font-medium tabular-nums text-muted">
      <span>{count(left)} {leftLabel}</span>
      <span>{count(right)} {rightLabel}</span>
    </div>
  </div>;
}

function Pulse({rows, sessions}: {rows: PulseRow[]; sessions: BreadthSession[]}) {
  const highs = rows.filter(row => row.newHigh).length, lows = rows.filter(row => row.newLow).length;
  const up = rows.filter(row => (row.returns.d1 ?? 0) > 0).length, down = rows.filter(row => (row.returns.d1 ?? 0) < 0).length;
  const stages = stageCounts(rows), staged = STAGES.reduce((sum, stage) => sum + stages[stage], 0);
  const above = participation(rows);
  const [page, setPage] = useState(0);
  return <Panel title="Market Breadth" bare aside={<span className="text-[12px] text-muted">{count(rows.length)} stocks</span>}>
    <div className="mkt-card mkt-pages" onScroll={event => {
      const box = event.currentTarget;
      setPage(Math.round(box.scrollLeft / Math.max(1, box.clientWidth)));
    }}>
    <div className="mkt-page">
    <Versus title="New Highs vs New Lows" left={highs} right={lows} leftLabel="Highs" rightLabel="Lows" />
    <Versus title="Advance vs Decline" left={up} right={down} leftLabel="Advance" rightLabel="Decline" />
    <div className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="m-0 text-[15px] font-semibold text-text">Stage Analysis</h3>
        <span className="text-[12px] text-muted">vs 150-day average</span>
      </div>
      <div className="flex h-2 gap-0.5" role="img" aria-label={STAGES.map(stage => `Stage ${stage}: ${stages[stage]}`).join(', ')}>
        {STAGES.map(stage => stages[stage] > 0 && <span key={stage} className="rounded-full" data-stage={stage} style={{flex: stages[stage], background: 'var(--tone)'}} />)}
      </div>
      <dl className="m-0 grid grid-cols-4 gap-2 max-sm:gap-1">
        {STAGES.map(stage => <div key={stage} className="flex min-w-0 flex-col gap-0.5" data-stage={stage} title={STAGE_HINT[stage]}>
          <dt className="flex items-center gap-1.5 text-[12px] font-medium text-secondary">
            <span className="size-1.5 shrink-0 rounded-full" style={{background: 'var(--tone)'}} />
            <span className="truncate">Stage {stage}</span>
          </dt>
          <dd className="m-0 text-[13px] font-medium tabular-nums text-muted max-sm:text-[11.5px]" title={`${STAGE_LABEL[stage]}: ${STAGE_HINT[stage]}`}>{count(stages[stage])} · {staged ? share(stages[stage] / staged) : '—'}</dd>
        </div>)}
      </dl>
    </div>
    </div>
    <div className="mkt-page">
    <div className="flex flex-col gap-3">
      <h3 className="m-0 text-[15px] font-semibold text-text">Above Moving Averages</h3>
      <div className="grid grid-cols-4 gap-3">
        {AVERAGES.map(period => <div key={period} className="flex flex-col gap-1.5">
          <div className="flex items-baseline justify-between gap-1">
            <span className="text-[12px] text-muted">{period}D</span>
            <span className="text-[13px] font-semibold tabular-nums text-text">{above[period] == null ? '—' : share(above[period]!)}</span>
          </div>
          <div className="h-1 overflow-hidden rounded-full bg-field" role="meter" aria-label={`Above ${period}-day average`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((above[period] ?? 0) * 100)}>
            <div className="h-full rounded-full bg-text" style={{width: `${(above[period] ?? 0) * 100}%`}} />
          </div>
        </div>)}
      </div>
    </div>
    {sessions.length > 1 && <ParticipationChart sessions={sessions} />}
    </div>
    </div>
    <div className="mkt-dots" aria-hidden="true">{[0, 1].map(index => <span key={index} data-on={page === index || undefined} />)}</div>
  </Panel>;
}

const GROUP_LIMIT = 10;

interface Butterfly { name: string; highs: string[]; lows: string[] }

/** New highs and new lows side by side for each group: lows grow left, highs grow right. */
function Extremes({rows, taxonomy, onOpenChart, onScreenSector}: {
  rows: PulseRow[];
  taxonomy?: Parameters<typeof breakdown>[2];
  onOpenChart: (symbol: string) => void;
  onScreenSector?: (sector: string) => void;
}) {
  const [grouping, setGrouping] = useState<Grouping>('sector');
  const [open, setOpen] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const sets = useMemo(() => ({highs: rows.filter(row => row.newHigh), lows: rows.filter(row => row.newLow)}), [rows]);
  const groups = useMemo<Butterfly[]>(() => {
    const merged = new Map<string, Butterfly>();
    const entry = (name: string) => merged.get(name) ?? merged.set(name, {name, highs: [], lows: []}).get(name)!;
    for (const group of breakdown(sets.highs, grouping, taxonomy)) entry(group.name).highs = group.symbols;
    for (const group of breakdown(sets.lows, grouping, taxonomy)) entry(group.name).lows = group.symbols;
    return [...merged.values()].sort((a, b) => (b.highs.length + b.lows.length) - (a.highs.length + a.lows.length)
      || b.highs.length - a.highs.length || a.name.localeCompare(b.name));
  }, [sets, grouping, taxonomy]);
  const names = useMemo(() => new Map(rows.map(row => [row.symbol, row.name])), [rows]);
  // One square-root scale for both sides: a single new high stays visible beside dozens of lows without looking equal.
  const peak = Math.sqrt(Math.max(1, ...groups.flatMap(group => [group.highs.length, group.lows.length])));
  const width = (value: number) => `${value ? Math.max(2, (Math.sqrt(value) / peak) * 100) : 0}%`;
  const highs = sets.highs.length, lows = sets.lows.length, total = highs + lows;
  const visible = all ? groups : groups.slice(0, GROUP_LIMIT);
  const chips = (symbols: string[], tone: 'up' | 'down') => <div className="flex flex-wrap gap-1" data-tone={tone}>
    {symbols.map(symbol => <button key={symbol} type="button" onClick={() => onOpenChart(symbol)} title={`${names.get(symbol) ?? symbol}: open in Charts`}
      className="mkt-sym">{symbol}</button>)}
  </div>;

  return <Panel title="New Highs & Lows" aside={<Segmented label="Group by" value={grouping} options={GROUPINGS}
    onChange={value => { setGrouping(value); setOpen(null); setAll(false); }} />}>
    <div className="flex flex-col gap-2.5">
      <div className="flex items-baseline justify-between gap-3 text-[13px]">
        <span data-tone="down"><b className="text-[22px] font-semibold tabular-nums tracking-[-0.02em]" style={{color: 'var(--tone)'}}>{count(lows)}</b>
          <span className="ml-1.5 text-muted">new lows</span></span>
        <span className="text-[12px] text-muted max-sm:hidden">52-week closes</span>
        <span data-tone="up" className="text-right"><span className="mr-1.5 text-muted">new highs</span>
          <b className="text-[22px] font-semibold tabular-nums tracking-[-0.02em]" style={{color: 'var(--tone)'}}>{count(highs)}</b></span>
      </div>
      <div className="flex h-1.5 gap-0.5" role="img" aria-label={`${lows} new lows, ${highs} new highs`}>
        {lows > 0 && <span className="rounded-full" data-tone="down" style={{flex: lows, background: 'var(--tone)'}} />}
        {highs > 0 && <span className="min-w-1.5 rounded-full" data-tone="up" style={{flex: highs, background: 'var(--tone)'}} />}
        {!total && <span className="flex-1 rounded-full bg-field" />}
      </div>
    </div>

    {groups.length ? <ul className="m-0 flex list-none flex-col p-0" aria-label={`New highs and lows by ${grouping}`}>
      {visible.map(group => {
        const expanded = open === group.name;
        return <li key={group.name} className="mkt-fly-item">
          <button type="button" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : group.name)} className="mkt-fly"
            title={`${group.name}: ${group.lows.length} new lows, ${group.highs.length} new highs`}>
            <span className="mkt-fly-side" data-tone="down">
              <span className="mkt-fly-count">{group.lows.length || ''}</span>
              <span className="mkt-fly-track"><span style={{width: width(group.lows.length)}} /></span>
            </span>
            <span className="mkt-fly-name">{group.name}</span>
            <span className="mkt-fly-side" data-tone="up">
              <span className="mkt-fly-track"><span style={{width: width(group.highs.length)}} /></span>
              <span className="mkt-fly-count">{group.highs.length || ''}</span>
            </span>
          </button>
          {expanded && <div className="mkt-fly-detail">
            {group.lows.length > 0 ? chips(group.lows, 'down') : <span className="text-[12px] text-muted">No new lows</span>}
            {group.highs.length > 0 ? chips(group.highs, 'up') : <span className="text-[12px] text-muted">No new highs</span>}
            {grouping === 'sector' && onScreenSector && group.name !== 'Unclassified' && <button type="button" onClick={() => onScreenSector(group.name)}
              className="col-span-full inline-flex items-center gap-1.5 justify-self-center text-[12px] font-medium text-muted hover:text-text">
              <SlidersHorizontal size={12} aria-hidden="true" />Screen all {group.name} stocks
            </button>}
          </div>}
        </li>;
      })}
    </ul> : <p className="m-0 py-6 text-center text-[12.5px] text-muted">No new highs or lows this session.</p>}
    {groups.length > GROUP_LIMIT && <button type="button" onClick={() => setAll(!all)} className="-mt-2 self-center text-[12px] font-medium text-muted hover:text-text">
      {all ? 'Top groups only' : `All ${groups.length} groups`}
    </button>}
  </Panel>;
}

const crore = (value: number) => `₹${value >= 1000 ? `${(value / 1000).toFixed(1)}k` : Math.round(value).toLocaleString('en-IN')} Cr`;

/** Where money moved: themes ranked by their value-weighted move, each naming the stocks that drove it. */
/** Listings from the last ~3 months that came through an IPO (an issue price), not old companies newly traded on NSE. */
const FRESH_DAYS = 92;
interface Fresh { symbol: string; name: string; sinceIssue: number; move: number | null; traded: number; listed: string }

function freshListings(ipos: IPORow[] | undefined, rows: PulseRow[], period: Period): Fresh[] {
  const pulse = new Map(rows.map(row => [row.symbol, row]));
  return (ipos ?? []).flatMap(ipo => {
    const issue = ipo.ipoResearch?.issuePrice, age = ipo.listingAgeCalendarDays;
    if (!issue || issue <= 0 || age == null || age < 0 || age > FRESH_DAYS || !(ipo.currentPrice > 0)) return [];
    const row = pulse.get(ipo.symbol);
    return [{symbol: ipo.symbol, name: ipo.name, sinceIssue: (ipo.currentPrice / issue - 1) * 100,
      move: row?.returns[period] ?? null, traded: row?.traded[period] ?? ipo.turnoverCrore, listed: ipo.listingDate}];
  });
}

/** Fresh listings stay apart from the pockets: each moves on its own story, so they are shown one by one. */
function FreshStrip({fresh, side, period}: {fresh: Fresh[]; side: 'lead' | 'lag'; period: Period}) {
  if (!fresh.length) return null;
  const direction = side === 'lead' ? 1 : -1;
  const score = (item: Fresh) => (item.move ?? item.sinceIssue) * Math.max(item.traded, 0);
  const shown = [...fresh].sort((a, b) => direction * (score(b) - score(a))).slice(0, 8);
  const above = fresh.filter(item => item.sinceIssue > 0).length;
  const label = PERIODS.find(([key]) => key === period)?.[1];
  return <div className="mkt-fresh">
    <div className="flex flex-wrap items-baseline justify-between gap-2 px-2.5">
      <span className="text-[13px] font-semibold text-text">Fresh listings <span className="font-normal text-muted">· last 3 months</span></span>
      <span className="text-[11.5px] tabular-nums text-muted">{fresh.length} IPOs · {above} above issue price</span>
    </div>
    <ul className="mkt-fresh-list">
      {shown.map(item => {
        const tone = (item.move ?? item.sinceIssue) >= 0 ? 'up' : 'down';
        return <li key={item.symbol} data-tone={tone} title={`${item.name}: listed ${item.listed}; ${signed(item.sinceIssue, 1)} vs issue price`}>
          <span className="truncate text-[13px] font-semibold text-text">{item.symbol}</span>
          {item.move == null ? <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-muted">New</span>
            : <span className="text-[13px] font-semibold tabular-nums" style={{color: 'var(--tone)'}}>{signed(item.move, 1)}</span>}
          <span className="truncate text-[11px] tabular-nums text-muted">{signed(item.sinceIssue, 0)} vs issue · {crore(item.traded)}/d</span>
          <span className="text-right text-[11px] text-muted">{item.move == null ? `since ${formatDate(item.listed, false)}` : label}</span>
        </li>;
      })}
    </ul>
  </div>;
}

function Themes({rows, taxonomy, ipos}: {rows: PulseRow[]; taxonomy?: Parameters<typeof themeFlows>[2]; ipos?: IPORow[]}) {
  const [period, setPeriod] = useState<Period>('m1');
  const [side, setSide] = useState<'lead' | 'lag'>('lead');
  const flows = useMemo(() => themeFlows(rows, period, taxonomy, side === 'lead' ? 1 : -1), [rows, period, taxonomy, side]);
  const shown = flows.filter(flow => !flow.cohort).slice(0, 16);
  const fresh = useMemo(() => freshListings(ipos, rows, period), [ipos, rows, period]);
  const peak = Math.max(1e-9, ...shown.map(flow => Math.abs(flow.flow)));
  const row = (flow: ThemeFlow, rank: number | null) => {
    const tone = flow.flow >= 0 ? 'up' : 'down';
    return <li key={flow.name} data-tone={tone} className="mkt-rank"
      style={{'--bar': `${Math.min(1, Math.abs(flow.flow) / peak) * 100}%`} as CSSProperties}
      title={`${flow.name}: value-weighted move of ${flow.members} stocks trading ${crore(flow.traded)} a day; ${flow.movers} ${side === 'lead' ? 'up' : 'down'} ${period === 'd1' ? '2' : '5'}%+`}>
      <span className="mkt-rank-no">{rank ?? '·'}</span>
      <span className="min-w-0">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-[13.5px] font-semibold text-text">{flow.name}</span>
          <span className="shrink-0 text-[10.5px] font-medium text-muted">{flow.cohort ? 'Cohort' : POCKET_LEVEL[flow.level]}</span>
        </span>
        <span className="block truncate text-[11.5px] tabular-nums text-muted">
          {flow.leaders.map(leader => `${leader.symbol} ${leader.move > 0 ? '+' : ''}${leader.move.toFixed(0)}%`).join('  ·  ')}
        </span>
      </span>
      <span className="text-right">
        <span className="block text-[14px] font-semibold tabular-nums" style={{color: 'var(--tone)'}}>{signed(flow.flow, 1)}</span>
        <span className="block text-[11px] tabular-nums text-muted">{crore(flow.traded)}/d</span>
      </span>
    </li>;
  };
  return <Panel title="Theme Tracker" bare aside={<div className="flex items-center gap-2">
    <Segmented label="Period" value={period} options={PERIODS} onChange={setPeriod} />
    <button type="button" className="mkt-icon" aria-pressed={side === 'lag'} onClick={() => setSide(side === 'lead' ? 'lag' : 'lead')}
      title={side === 'lead' ? 'Showing where money went in. Show where it left' : 'Showing where money left. Show where it went in'} aria-label="Show laggards">
      <SlidersHorizontal size={15} aria-hidden="true" />
    </button>
  </div>}>
    <p className="m-0 -mt-1 text-[12px] text-muted">{side === 'lead' ? 'Where money moved in' : 'Where money moved out'}: themes, industries and niches ranked by their move weighted by value traded, with the stocks that drove it.</p>
    {taxonomy ? <div className="mkt-card px-2 py-1.5">
      <ol className="mkt-ranks">{shown.map((flow, index) => row(flow, index + 1))}</ol>
      <FreshStrip fresh={fresh} side={side} period={period} />
    </div> : <p className="m-0 text-[12.5px] text-muted">Themes are unavailable in this release.</p>}
  </Panel>;
}

const TREND_SERIES = [
  {key: 'above_50_pct', label: 'Above 50-day', short: '50D', color: 'var(--series-1)'},
  {key: 'above_200_pct', label: 'Above 200-day', short: '200D', color: 'var(--series-2)'},
] as const;

/** Share of stocks above their 50- and 200-day averages over recent sessions, with a hover crosshair. */
function ParticipationChart({sessions}: {sessions: BreadthSession[]}) {
  const [hover, setHover] = useState<number | null>(null);
  const width = 640, height = 200, padLeft = 28, padRight = 52, padTop = 8, padBottom = 22;
  const plotW = width - padLeft - padRight, plotH = height - padTop - padBottom;
  const x = (index: number) => padLeft + (sessions.length < 2 ? 0 : (index / (sessions.length - 1)) * plotW);
  const y = (value: number) => padTop + (1 - value / 100) * plotH;
  const active = hover == null ? null : sessions[hover];
  return <div className="flex flex-col gap-2.5">
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <h3 className="m-0 text-[15px] font-semibold text-text">Participation · {sessions.length} sessions</h3>
      <div className="flex gap-3 text-[12px] text-muted" aria-hidden="true">
        {TREND_SERIES.map(series => <span key={series.key} className="inline-flex items-center gap-1.5">
          <span className="h-0.5 w-3 rounded-full" style={{background: series.color}} />{series.short}
        </span>)}
      </div>
    </div>
    <figure className="relative m-0">
      <svg viewBox={`0 0 ${width} ${height}`} className="block h-auto w-full touch-pan-y" role="img"
        aria-label={`Share of stocks above their 50- and 200-day averages over the last ${sessions.length} sessions`}
        onPointerLeave={() => setHover(null)}
        onPointerMove={event => {
          const box = event.currentTarget.getBoundingClientRect();
          const plotX = ((event.clientX - box.left) / box.width) * width - padLeft;
          setHover(Math.max(0, Math.min(sessions.length - 1, Math.round((plotX / plotW) * (sessions.length - 1)))));
        }}>
        {[0, 50, 100].map(tick => <g key={tick}>
          <line x1={padLeft} x2={padLeft + plotW} y1={y(tick)} y2={y(tick)} stroke="var(--line)" strokeWidth="1" strokeDasharray={tick === 50 ? '3 4' : undefined} />
          <text x={padLeft - 6} y={y(tick) + 3.5} textAnchor="end" fontSize="10" fill="var(--muted)">{tick}</text>
        </g>)}
        {[0, sessions.length - 1].map(index => sessions[index] &&
          <text key={index} x={x(index)} y={height - 6} textAnchor={index === 0 ? 'start' : 'end'} fontSize="10" fill="var(--muted)">{formatDate(sessions[index].date, false)}</text>)}
        {TREND_SERIES.map(series => {
          const points = sessions.flatMap((session, index) => session[series.key] == null ? [] : [`${x(index)},${y(session[series.key]!)}`]);
          const last = sessions.at(-1)?.[series.key];
          return <g key={series.key}>
            <polyline points={points.join(' ')} fill="none" stroke={series.color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
            {last != null && <text x={padLeft + plotW + 8} y={y(last) + 4} fontSize="11" fontWeight="600" fill="var(--secondary)">{pct(last)}</text>}
          </g>;
        })}
        {active && hover != null && <g pointerEvents="none">
          <line x1={x(hover)} x2={x(hover)} y1={padTop} y2={padTop + plotH} stroke="var(--line-strong)" strokeWidth="1" />
          {TREND_SERIES.map(series => active[series.key] != null &&
            <circle key={series.key} cx={x(hover)} cy={y(active[series.key]!)} r="4" fill={series.color} stroke="var(--surface)" strokeWidth="2" />)}
        </g>}
      </svg>
      {active && hover != null && <div className="pointer-events-none absolute top-1 rounded-(--radius-md) bg-surface px-2.5 py-1.5 text-[12px] shadow-(--shadow-pop)"
        style={{left: `${(x(hover) / width) * 100}%`, transform: `translateX(${hover > sessions.length / 2 ? 'calc(-100% - 10px)' : '10px'})`}}>
        <div className="mb-0.5 font-medium text-text">{formatDate(active.date)}</div>
        {TREND_SERIES.map(series => <div key={series.key} className="flex items-center gap-1.5 text-secondary">
          <span className="size-2 rounded-full" style={{background: series.color}} />{series.short}<span className="ml-auto pl-3 font-medium text-text">{pct(active[series.key], 1)}</span>
        </div>)}
      </div>}
    </figure>
  </div>;
}

/** Market breadth, where highs and lows cluster, and which themes lead, for the selected session. */
export default function MarketTab({datasetRevision, sessionDate, onOpenChart, onScreenSector}: {
  datasetRevision?: string;
  sessionDate: string;
  onOpenChart: (symbol: string) => void;
  onScreenSector?: (sector: string) => void;
}) {
  const market = useQuery({
    queryKey: ['marketOverview', datasetRevision],
    queryFn: () => screenerApi.getMarketOverview(datasetRevision),
    enabled: Boolean(sessionDate),
    staleTime: Infinity,
  });
  const pulse = useQuery({
    queryKey: ['marketPulse', datasetRevision],
    queryFn: () => screenerApi.getMarketPulse(datasetRevision),
    enabled: Boolean(sessionDate),
    staleTime: Infinity,
  });
  // The IPO page's catalogue (shared cache) identifies real new listings by their issue price.
  const ipos = useQuery({queryKey: ['ipos', datasetRevision], queryFn: () => screenerApi.getIpoCatalogue(), staleTime: Infinity, retry: false});
  // Themes are optional: without them the page still shows sectors and industries.
  const taxonomy = useQuery({
    queryKey: ['themeClassification', datasetRevision],
    queryFn: () => screenerApi.getThemeClassification(datasetRevision),
    enabled: Boolean(sessionDate),
    staleTime: Infinity,
    retry: false,
  });

  if (market.isPending) return <div className="market-view mkt" role="status" aria-label="Loading market overview">
    <div className="skeleton h-[92px]! w-full! rounded-(--radius-xl)!" />
    <div className="grid gap-4 xl:grid-cols-2">{Array.from({length: 2}, (_, index) => <div key={index} className="skeleton h-[420px]! w-full! rounded-(--radius-xl)!" />)}</div>
  </div>;
  if (market.isError) {
    const unpublished = market.error instanceof DataUnavailableError && market.error.reason === 'not_published';
    return <div className="market-view"><div role="alert" className="data-state rounded-(--radius-lg) bg-surface shadow-(--shadow-card)">
      <h2>{unpublished ? 'Market overview is not in this release yet' : 'Market overview could not be loaded'}</h2>
      <p>{unpublished ? 'It is published with each daily data refresh. Choose a newer session, or check back after the next refresh.' : market.error.message}</p>
      {!unpublished && <Button variant="secondary" onClick={() => void market.refetch()}>Retry</Button>}
    </div></div>;
  }

  const {breadth, indices, asOfDate} = market.data;
  const regime = marketRegime(breadth.at(-1)!);
  const rows = pulse.data?.rows;

  return <div className="market-view mkt"><div className="mkt-column">
    <header className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
      <h1 className="m-0 text-[20px] font-semibold tracking-[-0.02em] text-text">Market</h1>
      <span className="inline-flex h-6 items-center gap-1.5 rounded-full bg-surface px-2.5 text-[12px] font-semibold text-text shadow-(--shadow-control)"
        data-tone={regime.tone === 'negative' ? 'down' : 'up'}>
        {regime.tone !== 'neutral' && <span className="size-1.5 rounded-full" style={{background: 'var(--tone)'}} />}{regime.label}
      </span>
      <span className="text-[12.5px] text-muted">{formatDate(asOfDate)}</span>
    </header>

    {indices.length > 0 && <IndexCards indices={indices} />}
    {rows ? <Pulse rows={rows} sessions={breadth} /> : <PulseState pending={pulse.isPending} error={pulse.error} />}
    {rows && <Themes rows={rows} taxonomy={taxonomy.data} ipos={ipos.data?.records} />}
    {rows && <Extremes rows={rows} taxonomy={taxonomy.data} onOpenChart={onOpenChart} onScreenSector={onScreenSector} />}
  </div></div>;
}

function PulseState({pending, error}: {pending: boolean; error: Error | null}) {
  return pending
    ? <div className="skeleton h-[420px]! w-full! rounded-(--radius-xl)!" role="status" aria-label="Loading stock breadth" />
    : <div role="alert" className="rounded-(--radius-xl) bg-surface p-5 text-[12.5px] text-muted shadow-(--shadow-card)">
      Stock breadth could not be loaded{error ? `: ${error.message}` : '.'}
    </div>;
}
