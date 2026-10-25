import { useId, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, SlidersHorizontal } from 'lucide-react';
import { screenerApi } from '../api/screenerApi';
import { DataUnavailableError } from '../api/dataErrors';
import { marketRegime } from '../utils/marketOverview';
import {
  AVERAGES, GROUPINGS, PERIODS, STAGES, STAGE_HINT, STAGE_LABEL,
  breakdown, participation, stageCounts, themeMoves,
  type Grouping, type Period, type PulseRow,
} from '../utils/marketPulse';
import type { BreadthSession, IndexCard } from '../types/market';
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

type Side = 'highs' | 'lows';
const GROUP_LIMIT = 10;

/** New highs and new lows, and where they cluster: by sector, industry or theme. */
function Extremes({rows, taxonomy, onOpenChart, onScreenSector}: {
  rows: PulseRow[];
  taxonomy?: Parameters<typeof breakdown>[2];
  onOpenChart: (symbol: string) => void;
  onScreenSector?: (sector: string) => void;
}) {
  const [side, setSide] = useState<Side>('highs');
  const sideName = useId();
  const [grouping, setGrouping] = useState<Grouping>('sector');
  const [open, setOpen] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const sets = useMemo(() => ({highs: rows.filter(row => row.newHigh), lows: rows.filter(row => row.newLow)}), [rows]);
  const leaders = useMemo(() => ({highs: breakdown(sets.highs, 'sector').slice(0, 3), lows: breakdown(sets.lows, 'sector').slice(0, 3)}), [sets]);
  const groups = useMemo(() => breakdown(sets[side], grouping, taxonomy), [sets, side, grouping, taxonomy]);
  const names = useMemo(() => new Map(rows.map(row => [row.symbol, row.name])), [rows]);
  const peak = groups[0]?.count ?? 1;
  const choose = (next: Side) => { setSide(next); setOpen(null); setAll(false); };
  const visible = all ? groups : groups.slice(0, GROUP_LIMIT);

  return <Panel title="New Highs & Lows" aside={<span className="text-[12px] text-muted">52-week closes</span>}>
    <div className="grid grid-cols-2 gap-3" role="radiogroup" aria-label="New highs or new lows">
      {(['highs', 'lows'] as const).map(key => {
        const active = side === key;
        return <label key={key} data-tone={key === 'highs' ? 'up' : 'down'}
          className={`flex min-w-0 cursor-pointer flex-col gap-3 rounded-(--radius-lg) p-3.5 text-left transition ${active ? 'bg-surface ring-[1.5px] ring-(--tone) shadow-(--shadow-card)' : 'bg-surface-subtle hover:bg-surface-hover'}`}>
          <span className="flex items-center justify-between gap-2">
            <span className="text-[11.5px] font-bold uppercase tracking-[0.06em]" style={{color: 'var(--tone)'}}>New {key}</span>
            <input type="radio" name={sideName} value={key} checked={active} onChange={() => choose(key)}
              className="m-0 size-4 shrink-0 cursor-pointer" style={{accentColor: 'var(--tone)'}} />
          </span>
          <span className="text-[28px] font-semibold leading-none tabular-nums tracking-[-0.03em] text-text">{count(sets[key].length)}</span>
          <span className="flex flex-col gap-1">
            {leaders[key].length ? leaders[key].map(group => <span key={group.name} className="flex items-baseline justify-between gap-2 text-[12px]">
              <span className="truncate text-secondary">{group.name}</span>
              <span className="shrink-0 font-semibold tabular-nums" style={{color: 'var(--tone)'}}>{share(group.share)}</span>
            </span>) : <span className="text-[12px] text-muted">None this session</span>}
          </span>
        </label>;
      })}
    </div>

    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[13px] font-semibold text-text">New {side} by <span className="font-normal text-muted">· {groups.length} groups</span></span>
        <Segmented label="Group by" value={grouping} options={GROUPINGS} onChange={value => { setGrouping(value); setOpen(null); setAll(false); }} />
      </div>
      {groups.length ? <ul className="m-0 flex list-none flex-col p-0" data-tone={side === 'highs' ? 'up' : 'down'}>
        {visible.map(group => {
          const expanded = open === group.name;
          return <li key={group.name} className="border-t border-line first:border-t-0">
            <button type="button" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : group.name)}
              className="flex w-full flex-col gap-1.5 py-2.5 text-left">
              <span className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 truncate text-[13.5px] font-semibold text-text">{group.name}</span>
                <span className="flex shrink-0 items-baseline gap-2 tabular-nums">
                  <span className="text-[12px] text-muted">{group.count}</span>
                  <span className="w-10 text-right text-[13.5px] font-semibold" style={{color: 'var(--tone)'}}>{share(group.share)}</span>
                  <ChevronDown size={14} className={`self-center text-muted transition ${expanded ? 'rotate-180' : ''}`} aria-hidden="true" />
                </span>
              </span>
              <span className="h-1 overflow-hidden rounded-full bg-field"><span className="block h-full rounded-full" style={{width: `${(group.count / peak) * 100}%`, background: 'var(--tone)'}} /></span>
              {grouping === 'sector' && <span className="text-[11.5px] text-muted">{group.children} {group.children === 1 ? 'industry' : 'industries'}</span>}
            </button>
            {expanded && <div className="flex flex-col gap-2.5 pb-3.5">
              <div className="flex flex-wrap gap-1.5">
                {group.symbols.map(symbol => <button key={symbol} type="button" onClick={() => onOpenChart(symbol)} title={`${names.get(symbol) ?? symbol}: open in Charts`}
                  className="h-7 rounded-full bg-field px-2.5 text-[12px] font-semibold text-text transition hover:bg-surface-hover">
                  {symbol}
                </button>)}
              </div>
              {grouping === 'sector' && onScreenSector && group.name !== 'Unclassified' && <button type="button" onClick={() => onScreenSector(group.name)}
                className="inline-flex items-center gap-1.5 self-start text-[12px] font-medium text-muted hover:text-text">
                <SlidersHorizontal size={12} aria-hidden="true" />Screen all {group.name} stocks
              </button>}
            </div>}
          </li>;
        })}
      </ul> : <p className="m-0 py-6 text-center text-[12.5px] text-muted">No new {side} this session.</p>}
      {groups.length > GROUP_LIMIT && <button type="button" onClick={() => setAll(!all)} className="self-center text-[12px] font-medium text-muted hover:text-text">
        {all ? 'Top groups only' : `All ${groups.length} groups`}
      </button>}
    </div>
  </Panel>;
}

/** Each theme's median move, tinted by strength; the share of members up sits underneath. */
function Themes({rows, taxonomy}: {rows: PulseRow[]; taxonomy?: Parameters<typeof themeMoves>[2]}) {
  const [period, setPeriod] = useState<Period>('d1');
  const [side, setSide] = useState<'lead' | 'lag'>('lead');
  const moves = useMemo(() => themeMoves(rows, period, taxonomy), [rows, period, taxonomy]);
  const shown = (side === 'lead' ? moves : [...moves].reverse()).slice(0, 12);
  const peak = Math.max(1e-9, ...moves.map(move => Math.abs(move.median)));
  return <Panel title="Theme Tracker" bare aside={<div className="flex items-center gap-2">
    <Segmented label="Period" value={period} options={PERIODS} onChange={setPeriod} />
    <button type="button" className="mkt-icon" aria-pressed={side === 'lag'} onClick={() => setSide(side === 'lead' ? 'lag' : 'lead')}
      title={side === 'lead' ? 'Showing leaders. Show laggards' : 'Showing laggards. Show leaders'} aria-label="Show laggards">
      <SlidersHorizontal size={15} aria-hidden="true" />
    </button>
  </div>}>
    {side === 'lag' && <p className="m-0 -mt-1 text-[12px] text-muted">Weakest themes first</p>}
    {taxonomy ? <ul className="m-0 grid list-none grid-cols-4 gap-2.5 p-0 max-xl:grid-cols-3 max-lg:grid-cols-2">
      {shown.map(move => {
        const tone = move.median >= 0 ? 'up' : 'down', strength = Math.min(1, Math.abs(move.median) / peak);
        return <li key={move.name} data-tone={tone} title={`${move.name}: median of ${move.members} stocks, ${share(move.advancing)} of them up`}
          className="mkt-theme flex min-h-[58px] min-w-0 items-center justify-between gap-3 px-4 py-3 max-sm:gap-2 max-sm:px-3"
          style={{'--strength': `${10 + strength * 45}%`} as CSSProperties}>
          <span className="min-w-0 line-clamp-2 text-[14px] font-semibold leading-[1.25] text-text max-sm:text-[13px]">{move.name}</span>
          <span className="shrink-0 text-[14px] font-semibold tabular-nums max-sm:text-[13px]" style={{color: 'var(--tone)'}}>{signed(move.median)}</span>
        </li>;
      })}
    </ul> : <p className="m-0 text-[12.5px] text-muted">Themes are unavailable in this release.</p>}
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
    {rows && <Themes rows={rows} taxonomy={taxonomy.data} />}
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
