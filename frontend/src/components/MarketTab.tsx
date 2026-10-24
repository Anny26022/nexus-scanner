import { useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { screenerApi } from '../api/screenerApi';
import { DataUnavailableError } from '../api/dataErrors';
import { marketRegime } from '../utils/marketOverview';
import type { BreadthSession, IndexCard } from '../types/market';
import { Button } from './Button';

const formatDate = (date: string, withYear = true) => new Date(`${date}T00:00:00`)
  .toLocaleDateString('en-IN', {day: 'numeric', month: 'short', ...(withYear ? {year: 'numeric'} : {})});
const pct = (value: number | null | undefined, digits = 0) => value == null ? '—' : `${value.toFixed(digits)}%`;
const count = (value: number | null | undefined) => value == null ? '—' : value.toLocaleString('en-IN');

function Card({title, subtitle, action, children, className = ''}: {title: string; subtitle?: string; action?: ReactNode; children: ReactNode; className?: string}) {
  return <section className={`rounded-(--radius-lg) bg-surface p-5 shadow-(--shadow-card) ${className}`} aria-label={title}>
    <header className="mb-4 flex items-start justify-between gap-3">
      <div>
        <h2 className="m-0 text-[15px] font-semibold tracking-[-0.01em] text-text">{title}</h2>
        {subtitle && <p className="m-0 mt-0.5 text-[12.5px] text-muted">{subtitle}</p>}
      </div>
      {action}
    </header>
    {children}
  </section>;
}

function Sparkline({series, positive}: {series: number[]; positive: boolean}) {
  if (series.length < 2) return null;
  const min = Math.min(...series), max = Math.max(...series), span = max - min || 1;
  const points = series.map((value, index) => `${(index / (series.length - 1)) * 100},${34 - ((value - min) / span) * 30}`);
  const tone = positive ? 'var(--positive)' : 'var(--negative)';
  return <svg viewBox="0 0 100 36" preserveAspectRatio="none" className="h-9 w-full" aria-hidden="true">
    <path d={`M0,36 L${points.join(' L')} L100,36 Z`} fill={tone} opacity="0.08" />
    <polyline points={points.join(' ')} fill="none" stroke={tone} strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
  </svg>;
}

function IndexTile({index}: {index: IndexCard}) {
  const positive = (index.changePct ?? 0) >= 0;
  return <div className="flex min-w-0 flex-col gap-1 rounded-(--radius-lg) bg-surface px-4 pb-3 pt-3.5 shadow-(--shadow-card)"
    title={`${index.name}: ${index.series.length} sessions to ${formatDate(index.date)}`}>
    <span className="truncate text-[12.5px] font-medium text-muted">{index.name}</span>
    <span className="text-[19px] font-semibold tracking-[-0.02em] text-text">{index.close.toLocaleString('en-IN', {maximumFractionDigits: 2})}</span>
    <span className={`text-[12.5px] font-medium ${positive ? 'text-positive' : 'text-negative'}`}>
      {index.changePct == null ? '—' : `${positive ? '+' : ''}${index.changePct.toFixed(2)}%`}
    </span>
    <Sparkline series={index.series} positive={(index.series.at(-1) ?? 0) >= (index.series[0] ?? 0)} />
  </div>;
}

function Meter({label, value}: {label: string; value: number | null}) {
  return <div className="flex flex-col gap-1.5">
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-[12.5px] text-secondary">{label}</span>
      <span className="text-[15px] font-semibold text-text">{pct(value)}</span>
    </div>
    <div className="h-1.5 overflow-hidden rounded-full bg-field" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={value ?? 0}>
      <div className="h-full rounded-full bg-accent" style={{width: `${Math.max(0, Math.min(100, value ?? 0))}%`}} />
    </div>
  </div>;
}

const TREND_SERIES = [
  {key: 'above_50_pct', label: 'Above 50-day', short: '50-day', color: 'var(--series-1)'},
  {key: 'above_200_pct', label: 'Above 200-day', short: '200-day', color: 'var(--series-2)'},
] as const;

/** Share of stocks above their 50- and 200-day averages over recent sessions, with a hover crosshair. */
function BreadthTrend({sessions}: {sessions: BreadthSession[]}) {
  const [hover, setHover] = useState<number | null>(null);
  const width = 640, height = 180, padLeft = 30, padRight = 96, padTop = 8, padBottom = 22;
  const plotW = width - padLeft - padRight, plotH = height - padTop - padBottom;
  const x = (index: number) => padLeft + (sessions.length < 2 ? 0 : (index / (sessions.length - 1)) * plotW);
  const y = (value: number) => padTop + (1 - value / 100) * plotH;
  const active = hover == null ? null : sessions[hover];
  return <figure className="m-0">
    <div className="mb-2 flex gap-4 text-[12px] text-secondary" aria-hidden="true">
      {TREND_SERIES.map(series => <span key={series.key} className="inline-flex items-center gap-1.5">
        <span className="h-0.5 w-3.5 rounded-full" style={{background: series.color}} />{series.label}
      </span>)}
    </div>
    <div className="relative">
      <svg viewBox={`0 0 ${width} ${height}`} className="block h-auto w-full" role="img"
        aria-label={`Share of stocks above their 50- and 200-day averages over the last ${sessions.length} sessions`}
        onMouseLeave={() => setHover(null)}
        onMouseMove={event => {
          const box = event.currentTarget.getBoundingClientRect();
          const plotX = ((event.clientX - box.left) / box.width) * width - padLeft;
          setHover(Math.max(0, Math.min(sessions.length - 1, Math.round((plotX / plotW) * (sessions.length - 1)))));
        }}>
        {[0, 25, 50, 75, 100].map(tick => <g key={tick}>
          <line x1={padLeft} x2={padLeft + plotW} y1={y(tick)} y2={y(tick)} stroke="var(--line)" strokeWidth="1" />
          <text x={padLeft - 6} y={y(tick) + 3.5} textAnchor="end" fontSize="10" fill="var(--muted)">{tick}</text>
        </g>)}
        {[0, Math.floor((sessions.length - 1) / 2), sessions.length - 1].map(index => sessions[index] &&
          <text key={index} x={x(index)} y={height - 6} textAnchor={index === 0 ? 'start' : index === sessions.length - 1 ? 'end' : 'middle'} fontSize="10" fill="var(--muted)">{formatDate(sessions[index].date, false)}</text>)}
        {TREND_SERIES.map(series => {
          const points = sessions.flatMap((session, index) => session[series.key] == null ? [] : [`${x(index)},${y(session[series.key]!)}`]);
          const last = sessions.at(-1)?.[series.key];
          return <g key={series.key}>
            <polyline points={points.join(' ')} fill="none" stroke={series.color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
            {last != null && <text x={padLeft + plotW + 8} y={y(last) + 4} fontSize="11" fill="var(--secondary)">{series.short} {pct(last)}</text>}
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
          <span className="size-2 rounded-full" style={{background: series.color}} />{series.label}<span className="ml-auto pl-3 font-medium text-text">{pct(active[series.key], 1)}</span>
        </div>)}
      </div>}
    </div>
  </figure>;
}

function AdvanceDecline({session}: {session: BreadthSession}) {
  const up = session.advances ?? 0, down = session.declines ?? 0, flat = session.unchanged ?? 0, total = up + down + flat || 1;
  return <div className="flex flex-col gap-2">
    <div className="flex items-baseline justify-between text-[12.5px]">
      <span className="text-positive"><strong className="text-[17px] font-semibold text-text">{count(up)}</strong> advancing</span>
      <span className="text-negative">declining <strong className="text-[17px] font-semibold text-text">{count(down)}</strong></span>
    </div>
    <div className="flex h-2 gap-0.5 overflow-hidden rounded-full" role="img" aria-label={`${up} advancing, ${down} declining, ${flat} unchanged`}>
      <div className="rounded-l-full bg-positive" style={{width: `${(up / total) * 100}%`}} />
      {flat > 0 && <div className="bg-line-strong" style={{width: `${(flat / total) * 100}%`}} />}
      <div className="rounded-r-full bg-negative" style={{width: `${(down / total) * 100}%`}} />
    </div>
  </div>;
}

function Stat({label, value, hint}: {label: string; value: string; hint?: string}) {
  return <div className="flex flex-col gap-0.5 rounded-(--radius-md) bg-surface-subtle px-3 py-2.5">
    <span className="text-[12px] text-muted">{label}</span>
    <span className="text-[17px] font-semibold tracking-[-0.01em] text-text">{value}</span>
    {hint && <span className="text-[11.5px] text-muted">{hint}</span>}
  </div>;
}

/** Market breadth and key indices for the selected session. */
export default function MarketTab({datasetRevision, sessionDate}: {
  datasetRevision?: string;
  sessionDate: string;
  onScreenSector?: (sector: string) => void;
}) {
  const market = useQuery({
    queryKey: ['marketOverview', datasetRevision],
    queryFn: () => screenerApi.getMarketOverview(datasetRevision),
    enabled: Boolean(sessionDate),
    staleTime: Infinity,
  });

  if (market.isPending) return <div className="market-view" role="status" aria-label="Loading market overview">
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{Array.from({length: 4}, (_, index) => <div key={index} className="skeleton h-[128px]! w-full! rounded-(--radius-lg)!" />)}</div>
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
  const latest = breadth.at(-1)!;
  const regime = marketRegime(latest);
  const toneClass = regime.tone === 'positive' ? 'bg-accent-soft text-positive' : regime.tone === 'negative' ? 'bg-negative-soft text-negative' : 'bg-field text-secondary';

  return <div className="market-view">
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <span className={`inline-flex h-7 items-center rounded-full px-3 text-[12.5px] font-semibold ${toneClass}`}>{regime.label}</span>
      <span className="text-[13px] text-muted">Breadth across {count((latest.advances ?? 0) + (latest.declines ?? 0) + (latest.unchanged ?? 0))} NSE stocks · {formatDate(asOfDate)}</span>
    </div>

    {indices.length > 0 && <div className="grid grid-cols-2 gap-3 md:grid-cols-4" aria-label="Key indices">
      {indices.map(index => <IndexTile key={index.symbol} index={index} />)}
    </div>}

    <div className="grid gap-3 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
      <Card title="Breadth" subtitle="Share of stocks trading above their moving averages">
        <div className="mb-5 grid grid-cols-2 gap-x-6 gap-y-4 md:grid-cols-4">
          <Meter label="Above 10-day" value={latest.above_10_pct} />
          <Meter label="Above 20-day" value={latest.above_20_pct} />
          <Meter label="Above 50-day" value={latest.above_50_pct} />
          <Meter label="Above 200-day" value={latest.above_200_pct} />
        </div>
        <BreadthTrend sessions={breadth} />
      </Card>
      <Card title="Today" subtitle={formatDate(latest.date)}>
        <AdvanceDecline session={latest} />
        <div className="mt-5 grid grid-cols-2 gap-2.5">
          <Stat label="Up 4%+" value={count(latest.up_4)} />
          <Stat label="Down 4%+" value={count(latest.down_4)} />
          <Stat label="New 52W highs" value={count(latest.new_52w_high)} />
          <Stat label="New 52W lows" value={count(latest.new_52w_low)} />
          <Stat label="Net new highs" value={latest.nnh_52w == null ? '—' : `${latest.nnh_52w > 0 ? '+' : ''}${count(latest.nnh_52w)}`} hint="52-week highs minus lows" />
          <Stat label="Benchmark" value={latest.index_change_pct == null ? '—' : `${latest.index_change_pct > 0 ? '+' : ''}${latest.index_change_pct.toFixed(2)}%`} hint="Nifty 50 change" />
        </div>
      </Card>
    </div>
  </div>;
}
