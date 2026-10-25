import { useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, CandlestickChart, ChevronDown, ExternalLink, FileText, Minus, Search, X } from 'lucide-react';
import {
  GROUP_LABEL, QUALITY_ORDER, THEME_LEVELS, companyHistory, getEarningsFile, getEarningsIndex, groupRecords, median, periodLabel,
  qualityRank, seasonRecords, seasons, summarize, upcomingByDate, upcomingQuarters,
  type Classification, type EarningsRecord, type GroupBy,
} from '../api/earnings';
import { DataUnavailableError } from '../api/dataErrors';
import { decode } from '../api/rotation';
import { BUCKETS, RUN_UP, bucketOf, drift, reaction, story, type Bucket, type Reaction } from '../utils/earningsReaction';
import { screenerApi } from '../api/screenerApi';
import { useMountEffect } from '../hooks/useMountEffect';
import { useTableWindow } from '../hooks/useTableWindow';
import { Button } from './Button';
import { SymbolWithLogo } from './SymbolWithLogo';
import '../styles/earnings.css';

const crore = new Intl.NumberFormat('en-IN', {maximumFractionDigits: 0});
const day = (date: string, options: Intl.DateTimeFormatOptions = {day: 'numeric', month: 'short'}) =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString('en-IN', {...options, timeZone: 'UTC'});
const today = () => new Date().toLocaleDateString('en-CA', {timeZone: 'Asia/Kolkata'});
/** Signed percentage; a value that rounds to zero prints as 0, never "-0.0%". */
const pct = (value: number | null | undefined, digits = 0) => {
  if (value == null) return '—';
  const rounded = Number(value.toFixed(digits)) || 0;
  return `${rounded > 0 ? '+' : ''}${rounded.toFixed(digits)}%`;
};
const tone = (value: number | null | undefined, digits = 1) => {
  const rounded = value == null ? null : Number(value.toFixed(digits)) || 0;
  return rounded == null ? 'is-muted' : rounded > 0 ? 'is-up' : rounded < 0 ? 'is-down' : '';
};
/** "4:11 pm" from the provider's IST minutes; an estimated time reads "~4:11 pm". */
const filedAt = (record: EarningsRecord) => {
  const minutes = record.dropTime?.minutes;
  if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes < 0 || minutes >= 1440) return null;
  const hour = Math.floor(minutes / 60), text = `${hour % 12 || 12}:${String(minutes % 60).padStart(2, '0')} ${hour < 12 ? 'am' : 'pm'}`;
  return record.dropTime?.isEstimate ? `~${text}` : text;
};
const rupees = (value: number | null | undefined) => value == null ? '—' : `₹${crore.format(value / 1e7)} Cr`;
const VERDICT: Record<string, string> = {STRONG_BEAT: 'Strong beat', BEAT: 'Beat', 'IN-LINE': 'In line', MISS: 'Miss', STRONG_MISS: 'Strong miss'};
const TIMING: Record<string, string> = {After: 'After market', During: 'During market', Before: 'Before market', Holiday: 'Market holiday'};
/** When a result lands relative to trading hours; a weekend filing counts with market holidays. */
const SESSIONS = [['before', 'Pre-market'], ['during', 'Market hours'], ['after', 'Post-market'], ['closed', 'Weekend & holiday']] as const;
type Session = typeof SESSIONS[number][0];
const sessionOf = (record: EarningsRecord): Session | null => {
  const weekday = new Date(`${record.filing_day}T00:00:00Z`).getUTCDay();
  if (weekday === 0 || weekday === 6 || record.timing === 'Holiday') return 'closed';
  return record.timing === 'Before' ? 'before' : record.timing === 'During' ? 'during' : record.timing === 'After' ? 'after' : null;
};
type Lens = 'grade' | GroupBy;
const LENSES: [Lens, string][] = [['grade', 'Grade'], ...(['sector', 'industry', 'subIndustry', 'theme', 'block', 'macro'] as const)
  .map(level => [level, GROUP_LABEL[level]] as [Lens, string])];

type SortKey = 'filing_day' | 'quality' | 'revenue_yoy' | 'pat_yoy' | 'eps_yoy' | 'run_up' | 'day1' | 'drift' | 'since';
const resultKey = (record: EarningsRecord) => `${record.symbol}|${record.filing_day}`;

/** Wide screens keep the detail beside the list; narrower ones open it under its row. */
const SPLIT = '(min-width: 1180px)';
const subscribeSplit = (change: () => void) => { const query = matchMedia(SPLIT); query.addEventListener('change', change); return () => query.removeEventListener('change', change); };
const useSplit = () => useSyncExternalStore(subscribeSplit, () => matchMedia(SPLIT).matches, () => false);
type View = 'results' | 'reactions';
type ReactionOf = (record: EarningsRecord) => Reaction | null;

function Grade({quality}: {quality?: string | null}) {
  return quality ? <span className="ep-grade" data-grade={quality.toLowerCase()}>{quality}</span> : <span className="is-muted">—</span>;
}

function Direction({dir}: {dir?: string | null}) {
  return dir === 'up' ? <ArrowUp size={12} className="is-up" aria-label="Up" />
    : dir === 'down' ? <ArrowDown size={12} className="is-down" aria-label="Down" />
    : dir === 'flat' ? <Minus size={12} className="is-muted" aria-label="Flat" /> : null;
}

/** A growth figure over a bar scaled to ±100%, so a column reads at a glance. */
function Growth({value, amount, wide = false}: {value?: number | null; amount?: number | null; wide?: boolean}) {
  return <span className={`ep-growth${wide ? ' ep-wide' : ''}`}>
    <b className={tone(value)}>{pct(value)}</b>
    {amount != null && <small>{rupees(amount)}</small>}
    <i aria-hidden="true"><s data-down={(value ?? 0) < 0 || undefined} style={{width: `${Math.min(100, Math.abs(value ?? 0))}%`}} /></i>
  </span>;
}

/** Closes around the result, divided by the close before it: the run-up in grey, the reaction in its colour. */
function Path({value, height = 22, className = ''}: {value: Reaction; height?: number; className?: string}) {
  const points = value.path.map((close, i) => [i, close] as const).filter(([, close]) => Number.isFinite(close));
  if (points.length < 2) return null;
  const width = 100, lows = Math.min(...points.map(([, close]) => close)), highs = Math.max(...points.map(([, close]) => close));
  const span = highs - lows || 1, x = (i: number) => (i / Math.max(1, value.path.length - 1)) * width, y = (close: number) => height - 2 - ((close - lows) / span) * (height - 4);
  const line = (part: readonly (readonly [number, number])[]) => part.map(([i, close]) => `${x(i)},${y(close)}`).join(' ');
  return <svg className={`ep-path ${className}`} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true"
    style={{'--before': `${(value.at / Math.max(1, value.path.length - 1)) * 100}%`} as CSSProperties}>
    <line x1="0" x2={width} y1={y(1)} y2={y(1)} className="ep-path-base" vectorEffect="non-scaling-stroke" />
    <line x1={x(value.at)} x2={x(value.at)} y1="0" y2={height} className="ep-path-mark" vectorEffect="non-scaling-stroke" />
    <polyline points={line(points.filter(([i]) => i <= value.at))} className="ep-path-before" vectorEffect="non-scaling-stroke" />
    <polyline points={line(points.filter(([i]) => i >= value.at))} className={`ep-path-after ${tone(value.since)}`} vectorEffect="non-scaling-stroke" />
  </svg>;
}

const Filed = ({record}: {record: EarningsRecord}) => <span className="ep-num ep-wide ep-filed">
  {day(record.filing_day, {weekday: 'short', day: 'numeric', month: 'short'})}{filedAt(record) && <small>{filedAt(record)}</small>}</span>;

interface RowProps { record: EarningsRecord; move: Reaction | null; active: boolean; onOpen: () => void }

function Row({record, move, active, onOpen}: RowProps) {
  return <button type="button" className="ep-row" aria-current={active || undefined} onClick={onOpen}>
    <span className="ep-company">
      <SymbolWithLogo symbol={record.symbol} />
      <em>{record.company_name}</em>
    </span>
    <span><Grade quality={record.quality} /></span>
    <Growth value={record.revenue_yoy} amount={record.revenue} />
    <Growth value={record.pat_yoy} amount={record.net_income} />
    <Growth value={record.eps_yoy} wide />
    <span className={`ep-num ${tone(move?.since)}`}>{move && !move.sessions ? <small className="is-muted">Next session</small> : pct(move?.since, 1)}</span>
    <Filed record={record} />
  </button>;
}

/** The price story: the company with its one-line reading, the path, and the three moves that make it. */
function ReactionRow({record, move, active, onOpen}: RowProps) {
  const waiting = move != null && !move.sessions, after = move ? drift(move) : null;
  return <button type="button" className="ep-row ep-rrow" aria-current={active || undefined} onClick={onOpen}>
    <span className="ep-rstory">
      <span className="ep-company"><SymbolWithLogo symbol={record.symbol} /><Grade quality={record.quality} /></span>
      <span className="ep-rline">{move ? story(move) : 'Not in the price history'}</span>
    </span>
    <span className="ep-rpath">{move && <Path value={move} height={30} />}</span>
    <span className={`ep-num ep-wide ${tone(move?.runUp)}`}>{pct(move?.runUp, 1)}</span>
    <span className={`ep-num ${tone(move?.day1)}`}>{waiting ? '' : pct(move?.day1, 1)}</span>
    <span className={`ep-num ep-wide ${tone(after)}`}>{after == null ? '' : `${after > 0 ? '+' : ''}${after.toFixed(1)} pts`}</span>
    <span className={`ep-num ep-rsince ${tone(move?.since)}`}>{waiting ? <small className="is-muted">Next session</small> : pct(move?.since, 1)}</span>
  </button>;
}

/** Scroll updates stay here, leaving season aggregation and filters untouched. */
export function EarningsResults({records, children, onOpen, reactionOf = () => null, view = 'results', activeKey = null, expanded = null}: {
  records: EarningsRecord[]; children?: ReactNode; onOpen: (record: EarningsRecord) => void; reactionOf?: ReactionOf; view?: View;
  activeKey?: string | null; expanded?: ReactNode;
}) {
  const Item = view === 'reactions' ? ReactionRow : Row;
  const window = useTableWindow(records, null, 7, {rowHeight: 56, headerHeight: 30, narrow: true});
  const list = useRef<HTMLElement>(null);
  const update = useRef(window.update);
  update.current = window.update;
  useMountEffect(() => {
    const element = list.current!;
    const viewport = element.closest<HTMLElement>('.ep');
    if (!viewport) return;
    const sync = () => {
      const row = element.querySelector('.ep-row');
      const pitch = row ? Number.parseFloat(getComputedStyle(row).minHeight) || 56 : 56;
      update.current(viewport.getBoundingClientRect().top - element.getBoundingClientRect().top, viewport.clientHeight, pitch);
    };
    viewport.addEventListener('scroll', sync, {passive: true});
    const resize = new ResizeObserver(sync);
    resize.observe(viewport);
    sync();
    return () => { viewport.removeEventListener('scroll', sync); resize.disconnect(); };
  });
  return <section ref={list} className="ep-list" aria-label="Results">
      {children}
      {/* An open row changes the row pitch, so the whole list renders while one is open. */}
      {!expanded && <div aria-hidden="true" style={{height: window.top, flexShrink: 0}} />}
      {(expanded ? records : window.rows).map(record => {
        const active = resultKey(record) === activeKey;
        return <div key={resultKey(record)} className="ep-item">
          <Item record={record} move={reactionOf(record)} active={active} onOpen={() => onOpen(record)} />
          {active && expanded}
        </div>;
      })}
      {!expanded && <div aria-hidden="true" style={{height: window.bottom, flexShrink: 0}} />}
  </section>;
}

function Delta({label, value}: {label: string; value?: number | null}) {
  return <span className="ep-delta"><small>{label}</small><b className={tone(value)}>{pct(value, 1)}</b></span>;
}

function Detail({record, history, reactionOf, onOpenChart, lead = 'results'}: {
  record: EarningsRecord; history: EarningsRecord[] | null; reactionOf: ReactionOf; onOpenChart: () => void; lead?: View;
}) {
  const move = reactionOf(record);
  const past = (history ?? []).filter(row => row.filing_day < record.filing_day).slice(0, 4)
    .map(row => ({row, move: reactionOf(row)})).filter(entry => entry.move);
  const quarters = [...(history ?? [])].reverse();
  const peak = Math.max(1, ...quarters.map(row => Math.abs(row.pat_yoy ?? 0)));
  const reactions = move ? ([[`${RUN_UP} days before`, move.runUp], ['First day', move.day1],
    [`Since · ${move.sessions} ${move.sessions === 1 ? 'day' : 'days'}`, move.since]] as const).filter(([, value]) => value != null) : [];
  const guidance = ([['Growth', record.concall_guide_growth_txt, record.concall_guide_growth_dir], ['Margin', record.concall_guide_margin_txt, record.concall_guide_margin_dir],
    ['Capex', record.concall_guide_capex_txt, null]] as const).filter(([, text]) => text);
  return <article className="ep-detail" data-lead={lead} aria-label={`${record.symbol} result`}>
        <header className="ep-sheet-head">
          <h2 className="ep-sheet-title"><SymbolWithLogo symbol={record.symbol} size="md" /></h2>
        </header>
        <p className="ep-sheet-sub">{[record.company_name, record.industry].filter(Boolean).join(' · ')}</p>

        <section className="ep-sheet-hero">
          <div className="ep-sheet-badges">
            {record.quality && <span className="ep-badge" data-grade={record.quality.toLowerCase()}><i />{record.quality}</span>}
            {record.verdict && <span className="ep-badge" data-verdict={record.verdict.toLowerCase()}>{VERDICT[record.verdict] ?? record.verdict}</span>}
          </div>
          <p className="ep-sheet-big"><b className={tone(record.pat_yoy)}>{pct(record.pat_yoy, 1)}</b> profit growth</p>
          <p className="ep-sheet-when">{record.period_end ? `${periodLabel(record.period_end)} quarter` : record.quarter_label} · filed {day(record.filing_day)}
            {record.timing ? `, ${(TIMING[record.timing] ?? record.timing).toLowerCase()}` : ''}</p>
        </section>

        <section className="ep-cards">
          {([['Revenue', rupees(record.revenue), record.revenue_yoy, record.revenue_qoq], ['Net profit', rupees(record.net_income), record.pat_yoy, record.pat_qoq],
            ['EPS', record.eps == null ? '—' : `₹${record.eps.toFixed(2)}`, record.eps_yoy, record.eps_qoq]] as const).map(([label, value, yoy, qoq]) => <div key={label} className="ep-card">
            <small>{label}</small><strong>{value}</strong>
            <div><Delta label="YoY" value={yoy} /><Delta label="QoQ" value={qoq} /></div>
          </div>)}
          <div className="ep-card">
            <small>Operating margin</small><strong>{record.opm == null ? '—' : `${record.opm.toFixed(1)}%`}</strong>
            <div className="ep-card-note">{rupees(record.operating_profit)} operating profit</div>
          </div>
        </section>

        {reactions.length > 0 && <section className="ep-sheet-block ep-around">
          <h3>Around the result</h3>
          {move && <p className="ep-story">{story(move)}</p>}
          {move && <><Path value={move} height={64} className="ep-path-lg" />
            <div className="ep-path-axis" aria-hidden="true"><span>{RUN_UP} sessions before</span>
              <span>{move.sessions ? `${move.sessions} ${move.sessions === 1 ? 'session' : 'sessions'} after` : 'Result'}</span></div></>}
          <div className="ep-reactions">{reactions.map(([label, value]) => <span key={label}><small>{label}</small><b className={tone(value)}>{pct(value, 1)}</b></span>)}</div>
        </section>}

        {past.length > 0 && <section className="ep-sheet-block ep-earlier">
          <h3>How it took earlier results</h3>
          <div className="ep-past" role="table" aria-label="Earlier reactions">
            <div role="row" className="ep-past-head"><span role="columnheader">Quarter</span><span role="columnheader">{RUN_UP}d before</span>
              <span role="columnheader">Day 1</span><span role="columnheader">{RUN_UP}d after</span></div>
            {past.map(({row, move: then}) => <div role="row" key={row.filing_day}>
              <span role="cell">{row.period_end ? periodLabel(row.period_end) : row.quarter_label}{row.quality && <i data-grade={row.quality.toLowerCase()} title={row.quality} />}</span>
              <b role="cell" className={tone(then!.runUp)}>{pct(then!.runUp, 1)}</b>
              <b role="cell" className={tone(then!.day1)}>{pct(then!.day1, 1)}</b>
              <b role="cell" className={tone(then!.after)}>{pct(then!.after, 1)}</b>
            </div>)}
          </div>
        </section>}

        {(record.concall_sentiment || guidance.length > 0) && <section className="ep-sheet-block">
          <h3>Conference call {record.concall_sentiment && <span className="ep-chip" data-sentiment={record.concall_sentiment}>
            {record.concall_sentiment}{record.concall_tone ? ` · ${record.concall_tone}` : ''}</span>}</h3>
          <ul className="ep-guidance">{guidance.map(([label, text, dir]) => <li key={label}>
            <small>{label} <Direction dir={dir} /></small><span>{text!.replace(/^[↑↓→]\s*/, '')}</span></li>)}</ul>
        </section>}

        <section className="ep-sheet-block">
          <h3>Profit growth by quarter</h3>
          {!history ? <p className="is-muted" role="status">Loading past quarters…</p> : <div className="ep-quarters">
            {quarters.map(row => <div key={row.period_end} className="ep-quarter" data-current={row.period_end === record.period_end || undefined}>
              <b className={tone(row.pat_yoy)}>{pct(row.pat_yoy)}</b>
              <span className="ep-quarter-plot"><i data-down={(row.pat_yoy ?? 0) < 0 || undefined} style={{height: `${Math.max(3, Math.abs(row.pat_yoy ?? 0) / peak * 100)}%`}} /></span>
              <small>{periodLabel(row.period_end!).replace(' 20', " '")}</small>
              {row.quality && <span className="ep-quarter-grade" data-grade={row.quality.toLowerCase()} title={row.quality}><i />{row.quality}</span>}
            </div>)}
          </div>}
        </section>

        <footer className="ep-sheet-foot">
          {record.attachment_url && /^https:\/\//.test(record.attachment_url) && <a className="button button-secondary ep-button" href={record.attachment_url} target="_blank" rel="noopener noreferrer">
            <FileText size={14} aria-hidden="true" /> Filing <ExternalLink size={11} aria-hidden="true" /></a>}
          <Button variant="primary" className="ep-button" onClick={onOpenChart}><CandlestickChart size={14} aria-hidden="true" /> Open chart</Button>
        </footer>
  </article>;
}

const TIERS = [['Mega & large', ['Mega', 'Large']], ['Mid caps', ['Mid']], ['Small caps', ['Small']], ['Micro caps', ['Micro']]] as const;
const tierOf = (record: EarningsRecord) => TIERS.find(([, caps]) => (caps as readonly string[]).includes(record.cap_type ?? ''))?.[0] ?? 'Other';

interface Facet { label: string; records: EarningsRecord[]; medianPatYoy: number | null; grade?: string }
interface Day { date: string; reported: EarningsRecord[]; upcoming: EarningsRecord[] }

/** The season as a strip of days: reported days stack their grades, scheduled days are outlined. */
function Timeline({days, todayDate, active, onPick}: {days: Day[]; todayDate: string; active: string | null; onPick: (date: string | null) => void}) {
  const peak = Math.max(1, ...days.map(item => item.reported.length + item.upcoming.length));
  // A month label needs a few bars of room, or neighbouring labels collide.
  let month = '', sinceLabel = Infinity;
  return <div className="ep-timeline" role="listbox" aria-label="Season by day">
    {days.map(item => {
      const total = item.reported.length + item.upcoming.length;
      const label = day(item.date, {month: 'short'});
      const newMonth = label !== month && sinceLabel >= 3; if (label !== month) month = label; sinceLabel = newMonth ? 1 : sinceLabel + 1;
      const counts = summarize(item.reported).quality;
      return <button key={item.date} type="button" role="option" aria-selected={active === item.date} data-future={item.date > todayDate || undefined}
        data-today={item.date === todayDate || undefined} onClick={() => onPick(active === item.date ? null : item.date)}
        title={`${day(item.date, {weekday: 'short', day: 'numeric', month: 'short'})} · ${item.reported.length ? `${item.reported.length} reported` : ''}${item.reported.length && item.upcoming.length ? ', ' : ''}${item.upcoming.length ? `${item.upcoming.length} scheduled` : ''}`}>
        <span className="ep-tl-bar" style={{height: `${Math.max(6, total / peak * 100)}%`}}>
          {item.upcoming.length > 0 && <i className="is-upcoming" style={{flexGrow: item.upcoming.length}} />}
          {[...QUALITY_ORDER].reverse().map(grade => counts[grade] ? <i key={grade} data-grade={grade.toLowerCase()} style={{flexGrow: counts[grade]}} /> : null)}
          {item.reported.length - QUALITY_ORDER.reduce((sum, grade) => sum + (counts[grade] ?? 0), 0) > 0 && <i className="is-ungraded" style={{flexGrow: 1}} />}
        </span>
        <span className="ep-tl-day">{day(item.date, {day: 'numeric'})}</span>
        {newMonth && <span className="ep-tl-month">{label}</span>}
      </button>;
    })}
  </div>;
}

/** The season's first-day split as one bar; each part filters the list. */
function ReactionMix({counts, active, onPick}: {counts: Map<Bucket, number>; active: Bucket | null; onPick: (bucket: Bucket | null) => void}) {
  const total = BUCKETS.reduce((sum, [key]) => sum + (counts.get(key) ?? 0), 0);
  if (!total) return null;
  const waiting = counts.get('awaiting') ?? 0;
  return <div className="ep-mix" data-active={active ?? undefined}>
    <div className="ep-mix-bar" role="presentation">
      {BUCKETS.map(([key]) => (counts.get(key) ?? 0) > 0 && <button key={key} type="button" tabIndex={-1} aria-hidden="true" data-bucket={key}
        data-on={active === key || undefined} style={{flexGrow: counts.get(key)}} onClick={() => onPick(active === key ? null : key)} />)}
    </div>
    <div className="ep-mix-key" role="group" aria-label="First-day reaction">
      {BUCKETS.map(([key, label]) => <button key={key} type="button" data-bucket={key} aria-pressed={active === key} disabled={!counts.get(key)}
        onClick={() => onPick(active === key ? null : key)}><i aria-hidden="true" />{label} <b>{counts.get(key) ?? 0}</b></button>)}
      {waiting > 0 && <button type="button" data-bucket="awaiting" aria-pressed={active === 'awaiting'} onClick={() => onPick(active === 'awaiting' ? null : 'awaiting')}>
        {waiting} awaiting</button>}
    </div>
  </div>;
}

export default function EarningsTab({datasetRevision, onOpenChart}: {datasetRevision?: string; onOpenChart: (symbol: string) => void}) {
  const index = useQuery({queryKey: ['earnings-index'], queryFn: getEarningsIndex, staleTime: 5 * 60_000, retry: false});
  const allSeasons = useMemo(() => index.data ? seasons(index.data) : [], [index.data]);
  const [periodChoice, setPeriodChoice] = useState<string | null>(null);
  const season = allSeasons.find(item => item.periodEnd === periodChoice) ?? allSeasons[0];
  const isLatest = season === allSeasons[0];
  const [query, setQuery] = useState('');
  const [session, setSession] = useState<Session | null>(null);
  const [lens, setLens] = useState<Lens>('grade');
  const [focus, setFocus] = useState<string | null>(null);
  const [sort, setSort] = useState<SortKey>('filing_day');
  const [pick, setPick] = useState<string | null>(null);
  const [view, setView] = useState<View>('results');
  const [bucket, setBucket] = useState<Bucket | null>(null);
  const [searching, setSearching] = useState(false);
  const split = useSplit();
  const [activeDay, setActiveDay] = useState<string | null>(null);
  const todayDate = today();

  // Nexus's own classification, the same labels as the screener's grouped results.
  const directory = useQuery({queryKey: ['chart-rows', datasetRevision], queryFn: () => screenerApi.getChartRows(datasetRevision),
    staleTime: Infinity, retry: false, enabled: lens !== 'grade'});
  const themes = useQuery({queryKey: ['theme-classification', datasetRevision], queryFn: () => screenerApi.getThemeClassification(datasetRevision),
    staleTime: Infinity, retry: false, enabled: THEME_LEVELS.has(lens)});
  const classification = useMemo(() => {
    const map = new Map<string, Classification>();
    for (const row of directory.data ?? []) map.set(row.symbol, {sector: row.sector, industry: row.industry});
    for (const [symbol, record] of Object.entries(themes.data?.records ?? {})) map.set(symbol, {...map.get(symbol), theme: record.theme, subIndustry: record.subIndustry, block: record.block, macro: record.macro});
    return map;
  }, [directory.data, themes.data]);

  // Daily closes for every stock: the Rotation page's price history, shared through the same query keys.
  const prices = useQuery({queryKey: ['rotation-index', datasetRevision], queryFn: () => screenerApi.getRotationIndex(datasetRevision), staleTime: Infinity, retry: 1});
  const priceShards = useQueries({queries: (['core', 'rest'] as const).map(name => ({
    queryKey: ['rotation-shard', datasetRevision, name], queryFn: () => screenerApi.getRotationShard(datasetRevision, name),
    staleTime: Infinity, retry: 1, enabled: Boolean(prices.data),
  }))});
  const shardStamp = priceShards.map(shard => shard.dataUpdatedAt).join();
  const reactionOf = useMemo<ReactionOf>(() => {
    const index = prices.data, dates = index?.frames.D ?? [];
    const shards = Object.fromEntries(priceShards.flatMap(shard => shard.data ? [[shard.data.shard, shard.data]] : []));
    const shardOf = new Map(index?.stocks.map(row => [row.s, row.h]) ?? []);
    const closes = new Map<string, Float64Array | null>(), moves = new Map<string, Reaction | null>();
    const closesOf = (symbol: string) => {
      if (!closes.has(symbol)) {
        const coded = shards[shardOf.get(symbol) ?? '']?.series.D[symbol];
        closes.set(symbol, coded && index ? decode(coded, dates.length, index.scale) : null);
      }
      return closes.get(symbol)!;
    };
    return record => {
      const key = `${record.symbol}|${record.filing_day}`;
      if (!moves.has(key)) {
        const series = closesOf(record.symbol);
        moves.set(key, series ? reaction(dates, series, record.filing_day, record.timing) : null);
      }
      return moves.get(key)!;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prices.data, shardStamp]);

  const fileQuery = (ref: {sha256: string; url: string; count: number}, enabled = true) => ({
    queryKey: ['earnings-file', ref.sha256], queryFn: () => getEarningsFile(ref), staleTime: Infinity, retry: 1, enabled,
  });
  const seasonFiles = useQueries({queries: (season?.quarters ?? []).map(quarter => fileQuery(index.data!.quarters[quarter].published))});
  const calendarFiles = useQueries({queries: (index.data ? upcomingQuarters(index.data, todayDate) : [])
    .map(quarter => fileQuery(index.data!.quarters[quarter].upcoming, isLatest))});
  // A company's history needs every season; fetched only once a company is opened.
  const historyFiles = useQueries({queries: Object.values(index.data?.quarters ?? {}).map(entry => fileQuery(entry.published, split || pick !== null))});

  const seasonLoading = seasonFiles.some(file => file.isPending);
  const seasonError = seasonFiles.find(file => file.isError)?.error;
  const matches = (record: EarningsRecord) => {
    const text = query.trim().toLowerCase();
    return (!text || record.symbol.toLowerCase().includes(text) || Boolean(record.company_name?.toLowerCase().includes(text)))
      && (!session || sessionOf(record) === session);
  };
  // About 2,000 rows a season: cheap to derive each render.
  const records = (season && !seasonLoading && !seasonError ? seasonRecords(seasonFiles.map(file => file.data ?? []), season.periodEnd) : []).filter(matches);
  const upcoming = isLatest ? upcomingByDate(calendarFiles.flatMap(file => file.data ?? []), todayDate) : [];

  const byDate = new Map<string, Day>();
  const dayOf = (date: string) => byDate.get(date) ?? byDate.set(date, {date, reported: [], upcoming: []}).get(date)!;
  for (const record of records) dayOf(record.filing_day).reported.push(record);
  for (const [date, rows] of upcoming) dayOf(date).upcoming.push(...rows.filter(matches));
  const days = [...byDate.values()].filter(item => item.reported.length + item.upcoming.length).sort((a, b) => a.date.localeCompare(b.date));
  const picked = days.find(item => item.date === activeDay) ?? null;
  // A day with nothing reported yet shows its schedule; otherwise the page shows results.
  const scheduleMode = picked !== null && !picked.reported.length;
  const base = scheduleMode ? picked.upcoming : picked ? picked.reported : records;
  const nextWeek = upcoming.filter(([date]) => date <= new Date(Date.parse(`${todayDate}T00:00:00Z`) + 7 * 864e5).toISOString().slice(0, 10))
    .reduce((sum, [, rows]) => sum + rows.filter(matches).length, 0);

  const classify = (symbol: string) => classification.get(symbol);
  const classifying = lens !== 'grade' && (directory.isPending || (THEME_LEVELS.has(lens) && themes.isPending));
  const facets: Facet[] = classifying ? [] : lens !== 'grade' ? groupRecords(base, lens, classify)
    : scheduleMode ? TIERS.map(([label]) => ({label, records: base.filter(row => tierOf(row) === label), medianPatYoy: null})).filter(facet => facet.records.length)
    : QUALITY_ORDER.map(grade => {
      const rows = base.filter(row => row.quality === grade);
      return {label: grade, grade, records: rows, medianPatYoy: summarize(rows).medianPatYoy};
    });
  const focused = facets.find(facet => facet.label === focus) ?? null;
  const inFacet = focused ? focused.records : base;
  const bucketOfRecord = (record: EarningsRecord) => { const move = reactionOf(record); return move ? bucketOf(move) : null; };
  const buckets = new Map<Bucket, number>();
  if (view === 'reactions') for (const record of inFacet) { const found = bucketOfRecord(record); if (found) buckets.set(found, (buckets.get(found) ?? 0) + 1); }
  const visible = view === 'reactions' && bucket ? inFacet.filter(record => bucketOfRecord(record) === bucket) : inFacet;
  const key = (record: EarningsRecord) => sort === 'quality' ? -qualityRank(record.quality)
    : sort === 'run_up' ? reactionOf(record)?.runUp : sort === 'day1' ? reactionOf(record)?.day1 : sort === 'drift' ? (move => move && drift(move))(reactionOf(record)) : sort === 'since' ? reactionOf(record)?.since : record[sort];
  const sorted = [...visible].sort((a, b) => {
    const left = key(a), right = key(b);
    if (left == null || right == null) return left == null ? (right == null ? 0 : 1) : -1;
    return typeof left === 'string' ? (right as string).localeCompare(left) : (right as number) - (left as number);
  });
  const summary = summarize(visible);
  // Split view always shows a result (the top one until another is picked); otherwise only an opened row does.
  const active = sorted.find(record => resultKey(record) === pick) ?? (split ? sorted[0] : undefined);
  const history = active && !historyFiles.some(file => file.isPending) ? companyHistory(historyFiles.map(file => file.data ?? []), active.symbol) : null;
  const detail = active && <Detail record={active} history={history} reactionOf={reactionOf} onOpenChart={() => onOpenChart(active.symbol)} lead={view} />;
  const open = (record: EarningsRecord) => setPick(!split && pick === resultKey(record) ? null : resultKey(record));
  const steps = useRef({sorted, active, split});
  steps.current = {sorted, active, split};
  useMountEffect(() => {
    const key = (event: KeyboardEvent) => {
      const {sorted: rows, active: current, split: beside} = steps.current;
      if (!beside || !current || (event.key !== 'ArrowDown' && event.key !== 'ArrowUp')) return;
      if ((event.target as HTMLElement).closest('input, select, textarea')) return;
      const next = rows[rows.indexOf(current) + (event.key === 'ArrowDown' ? 1 : -1)];
      if (!next) return;
      event.preventDefault();
      setPick(resultKey(next));
      document.querySelector(`.ep-row[aria-current]`)?.parentElement?.[event.key === 'ArrowDown' ? 'nextElementSibling' : 'previousElementSibling']?.scrollIntoView({block: 'nearest'});
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  });

  const sortButton = (value: SortKey, label: string, className = '') => <button type="button" className={`ep-sort ${className}`} aria-pressed={sort === value}
    onClick={() => { setSort(value); }}>{label}{sort === value && <ArrowDown size={10} aria-hidden="true" />}</button>;

  if (index.isPending) return <div className="ep"><p className="ep-state" role="status">Loading earnings…</p></div>;
  if (index.isError || !season) {
    const unpublished = index.error instanceof DataUnavailableError || !season;
    return <div className="ep"><div className="ep-state" role="alert">
      <h2>{unpublished ? 'Earnings history is not published yet' : 'Earnings could not be loaded'}</h2>
      <p>{unpublished ? 'It appears after the next daily refresh.' : String(index.error)}</p>
    </div></div>;
  }

  const medianRunUp = median(visible.map(row => reactionOf(row)?.runUp));
  const medianSince = median(visible.map(row => reactionOf(row)?.since));
  const beats = (summary.verdicts.STRONG_BEAT ?? 0) + (summary.verdicts.BEAT ?? 0);
  const misses = (summary.verdicts.MISS ?? 0) + (summary.verdicts.STRONG_MISS ?? 0);
  const scope = [picked && day(picked.date, {weekday: 'long', day: 'numeric', month: 'short'}), focused?.label].filter(Boolean).join(' · ');

  return <div className="ep">
    <header className="ep-hero">
      <div className="ep-hero-top">
        <label className="ep-period"><span className="sr-only">Quarter</span>
          <select value={season.periodEnd} onChange={event => { setPeriodChoice(event.target.value); setActiveDay(null); setFocus(null); }}>
            {allSeasons.map(item => <option key={item.periodEnd} value={item.periodEnd}>{item.label} quarter</option>)}
          </select><ChevronDown size={12} aria-hidden="true" /></label>
        <span className="ep-checked">Updated {new Date(season.checkedAt).toLocaleString('en-IN', {day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'})}</span>
      </div>
      {seasonLoading ? <h1 className="ep-headline is-muted">Reading the season…</h1>
        : scheduleMode ? <h1 className="ep-headline">{base.length} {base.length === 1 ? 'company reports' : 'companies report'} <span>{day(picked!.date, {weekday: 'long', day: 'numeric', month: 'long'})}</span></h1>
        : <h1 className="ep-headline">Profits {(summary.medianPatYoy ?? 0) >= 0 ? 'up' : 'down'} <b className={tone(summary.medianPatYoy)}>{summary.medianPatYoy == null ? '—' : `${Math.abs(summary.medianPatYoy).toFixed(1)}%`}</b> at the median
          <span> across {summary.reported.toLocaleString('en-IN')} results{scope ? ` · ${scope}` : ''}</span></h1>}
      {!seasonLoading && !scheduleMode && <dl className="ep-facts">
        <div><dt>Sales</dt><dd className={tone(summary.medianRevenueYoy)}>{pct(summary.medianRevenueYoy, 1)}</dd></div>
        <div><dt>EPS</dt><dd className={tone(median(visible.map(row => row.eps_yoy)))}>{pct(median(visible.map(row => row.eps_yoy)), 1)}</dd></div>
        <div><dt>Beat · miss</dt><dd><span className="is-up">{beats}</span><span className="is-muted"> · </span><span className="is-down">{misses}</span></dd></div>
        <div><dt>Into results</dt><dd className={tone(medianRunUp)}>{pct(medianRunUp, 1)}</dd></div>
        <div><dt>Since results</dt><dd className={tone(medianSince)}>{pct(medianSince, 1)}</dd></div>
        {isLatest && <div><dt>Next 7 days</dt><dd>{nextWeek.toLocaleString('en-IN')} <small>to report</small></dd></div>}
      </dl>}
      {days.length > 0 && <Timeline days={days} todayDate={todayDate} active={picked?.date ?? null}
        onPick={date => { setActiveDay(date); setFocus(null); }} />}
      <div className="ep-tl-key" aria-hidden="true">
        {QUALITY_ORDER.map(grade => <span key={grade} data-grade={grade.toLowerCase()}><i />{grade}</span>)}
        {isLatest && <span><i className="is-upcoming" />Scheduled</span>}
        {picked && <button type="button" onClick={() => setActiveDay(null)}>Whole season <X size={11} /></button>}
      </div>
    </header>

    <div className="ep-desk" data-split={split || undefined}>
      <main className="ep-main">
        <div className="ep-bar">
          {!scheduleMode && <div className="ep-views" role="tablist" aria-label="View">
            {([['results', 'Results'], ['reactions', 'Reactions']] as const).map(([value, label]) => <button key={value} type="button" role="tab"
              aria-selected={view === value} onClick={() => { setView(value); setBucket(null); setSort(value === 'reactions' ? 'since' : 'filing_day'); }}>{label}</button>)}
          </div>}
          <label className="ep-quiet"><span className="sr-only">Break down by</span>
            <select value={lens} onChange={event => { setLens(event.target.value as Lens); setFocus(null); }}>
              {LENSES.map(([value, label]) => <option key={value} value={value}>{value === 'grade' && scheduleMode ? 'Size' : label}</option>)}
            </select><ChevronDown size={11} aria-hidden="true" /></label>
          <label className="ep-quiet" data-active={focus ? true : undefined}><span className="sr-only">Group</span>
            <select value={focus ?? ''} disabled={classifying} onChange={event => { setFocus(event.target.value || null); }}>
              <option value="">{classifying ? 'Loading…' : `All ${lens === 'grade' ? (scheduleMode ? 'sizes' : 'grades') : GROUP_LABEL[lens as GroupBy].toLowerCase() + 's'}`}</option>
              {facets.map(facet => <option key={facet.label} value={facet.label}>{facet.label} · {facet.records.length}</option>)}
            </select><ChevronDown size={11} aria-hidden="true" /></label>
          <span className="ep-spacer" />
          <label className="ep-quiet" data-active={session ? true : undefined}><span className="sr-only">Filing time</span>
            <select value={session ?? ''} onChange={event => { setSession((event.target.value || null) as Session | null); }}>
              <option value="">Any time</option>{SESSIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select><ChevronDown size={11} aria-hidden="true" /></label>
          <span className="ep-count">{sorted.length.toLocaleString('en-IN')}</span>
          <label className="ep-search" data-open={searching || query ? true : undefined}>
            <button type="button" aria-label="Find a company" onClick={() => setSearching(true)}><Search size={14} aria-hidden="true" /></button>
            <input type="search" placeholder="Find a company" aria-label="Search company" value={query} onBlur={() => setSearching(false)}
              ref={input => { if (searching) input?.focus(); }} onChange={event => { setQuery(event.target.value); }} />
          </label>
        </div>

        {view === 'reactions' && !scheduleMode && !seasonLoading && <ReactionMix counts={buckets} active={bucket} onPick={setBucket} />}

        {seasonError ? <div className="ep-state" role="alert"><h2>Results could not be loaded</h2><p>{String(seasonError)}</p></div>
          : seasonLoading || classifying ? <p className="ep-state" role="status">Loading…</p>
          : !sorted.length ? <p className="ep-state">Nothing matches. Try another day or clear a filter.</p>
          : scheduleMode ? <ul className="ep-tiles">{sorted.map(record => <li key={record.symbol}>
            <button type="button" className="ep-upcoming" onClick={() => onOpenChart(record.symbol)} title={`Open ${record.symbol} chart`}>
              <SymbolWithLogo symbol={record.symbol} />
              <em>{record.company_name}</em>
              <span>{[record.cap_type && `${record.cap_type} cap`, record.industry ?? record.sector, record.timing && (TIMING[record.timing] ?? record.timing)].filter(Boolean).join(' · ')}</span>
            </button></li>)}</ul>
          : <EarningsResults key={JSON.stringify([season.periodEnd, activeDay, lens, focus, sort, query, session, view, bucket])} records={sorted} onOpen={open}
            reactionOf={reactionOf} view={view} activeKey={active ? resultKey(active) : null} expanded={!split && active ? <div className="ep-inline">{detail}</div> : null}>
            {view === 'reactions' ? <div className="ep-cols ep-rcols">
                <span>Company</span><span className="ep-rpath-head">{RUN_UP} days before · after</span>
                {sortButton('run_up', 'Before', 'ep-num ep-wide')}{sortButton('day1', 'Day 1', 'ep-num')}{sortButton('drift', 'After D1', 'ep-num ep-wide')}{sortButton('since', 'Since', 'ep-num')}
              </div>
            : <div className="ep-cols">
              <span>Company</span>{sortButton('quality', 'Grade')}{sortButton('revenue_yoy', 'Sales', 'ep-num')}{sortButton('pat_yoy', 'Profit', 'ep-num')}
              {sortButton('eps_yoy', 'EPS', 'ep-num ep-wide')}{sortButton('since', 'Since', 'ep-num')}{sortButton('filing_day', 'Filed', 'ep-num ep-wide')}
            </div>}
          </EarningsResults>}
      </main>
      {split && !scheduleMode && <aside className="ep-panel" aria-label="Selected result">{detail}</aside>}
    </div>
  </div>;
}
