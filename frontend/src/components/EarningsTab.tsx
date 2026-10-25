import { useMemo, useRef, useState, type ReactNode } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import * as RadixDialog from '@radix-ui/react-dialog';
import { ArrowDown, ArrowUp, CandlestickChart, ChevronDown, Clock, ExternalLink, FileText, Minus, Search, X } from 'lucide-react';
import {
  GROUP_LABEL, QUALITY_ORDER, THEME_LEVELS, companyHistory, getEarningsFile, getEarningsIndex, groupRecords, median, periodLabel,
  qualityRank, seasonRecords, seasons, summarize, upcomingByDate, upcomingQuarters,
  type Classification, type EarningsRecord, type GroupBy,
} from '../api/earnings';
import { DataUnavailableError } from '../api/dataErrors';
import { screenerApi } from '../api/screenerApi';
import { useMountEffect } from '../hooks/useMountEffect';
import { useTableWindow } from '../hooks/useTableWindow';
import { Button } from './Button';
import { SymbolWithLogo } from './SymbolWithLogo';
import {joinCompanyClassification} from '../data/classification';

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
const LENSES: [Lens, string][] = [['grade', 'Grade'], ...(['sector', 'industry', 'subIndustry', 'theme', 'block', 'macro', 'cohort', 'aggregate'] as const)
  .map(level => [level, GROUP_LABEL[level]] as [Lens, string])];

type SortKey = 'filing_day' | 'quality' | 'revenue_yoy' | 'pat_yoy' | 'eps_yoy' | 'post_earnings_pct';

function Grade({quality}: {quality?: string | null}) {
  return quality ? <span className="ep-grade" data-grade={quality.toLowerCase()}>{quality}</span> : <span className="is-muted">—</span>;
}

function Direction({dir}: {dir?: string | null}) {
  return dir === 'up' ? <ArrowUp size={12} className="is-up" aria-label="Up" />
    : dir === 'down' ? <ArrowDown size={12} className="is-down" aria-label="Down" />
    : dir === 'flat' ? <Minus size={12} className="is-muted" aria-label="Flat" /> : null;
}

/** A growth figure over a bar scaled to ±100%, so a column reads at a glance. */
function Growth({value, wide = false}: {value?: number | null; wide?: boolean}) {
  return <span className={`ep-growth${wide ? ' ep-wide' : ''}`}>
    <b className={tone(value)}>{pct(value)}</b>
    <i aria-hidden="true"><s data-down={(value ?? 0) < 0 || undefined} style={{width: `${Math.min(100, Math.abs(value ?? 0))}%`}} /></i>
  </span>;
}

function Row({record, onOpen}: {record: EarningsRecord; onOpen: () => void}) {
  return <button type="button" className="ep-row" onClick={onOpen}>
    <span className="ep-company">
      <SymbolWithLogo symbol={record.symbol} />
      <em>{record.company_name}</em>
    </span>
    <span><Grade quality={record.quality} /></span>
    <Growth value={record.revenue_yoy} />
    <Growth value={record.pat_yoy} />
    <Growth value={record.eps_yoy} wide />
    <span className={`ep-num ${tone(record.post_earnings_pct)}`}>{pct(record.post_earnings_pct, 1)}</span>
    <span className="ep-num ep-wide is-muted">{day(record.filing_day)}</span>
  </button>;
}

/** Scroll updates stay here, leaving season aggregation and filters untouched. */
export function EarningsResults({records, children, onOpen}: {records: EarningsRecord[]; children?: ReactNode; onOpen: (record: EarningsRecord) => void}) {
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
      <div aria-hidden="true" style={{height: window.top, flexShrink: 0}} />
      {window.rows.map(record => <Row key={record.symbol} record={record} onOpen={() => onOpen(record)} />)}
      <div aria-hidden="true" style={{height: window.bottom, flexShrink: 0}} />
  </section>;
}

function Delta({label, value}: {label: string; value?: number | null}) {
  return <span className="ep-delta"><small>{label}</small><b className={tone(value)}>{pct(value, 1)}</b></span>;
}

function Sheet({record, history, onClose, onOpenChart}: {
  record: EarningsRecord; history: EarningsRecord[] | null; onClose: () => void; onOpenChart: () => void;
}) {
  const quarters = [...(history ?? [])].reverse();
  const peak = Math.max(1, ...quarters.map(row => Math.abs(row.pat_yoy ?? 0)));
  const reactions = ([['Opening gap', record.post_earnings_gap_pct], ['First day', record.post_earnings_first_day_pct], ['Since results', record.post_earnings_pct]] as const)
    .filter(([, value]) => value != null);
  const guidance = ([['Growth', record.concall_guide_growth_txt, record.concall_guide_growth_dir], ['Margin', record.concall_guide_margin_txt, record.concall_guide_margin_dir],
    ['Capex', record.concall_guide_capex_txt, null]] as const).filter(([, text]) => text);
  return <RadixDialog.Root open onOpenChange={open => { if (!open) onClose(); }}>
    <RadixDialog.Portal>
      <RadixDialog.Overlay className="ep-sheet-overlay" />
      <RadixDialog.Content className="ep-sheet" aria-describedby={undefined}>
        <header className="ep-sheet-head">
          <RadixDialog.Title asChild><div className="ep-sheet-title"><SymbolWithLogo symbol={record.symbol} size="md" /></div></RadixDialog.Title>
          <RadixDialog.Close className="ep-close" aria-label="Close"><X size={15} /></RadixDialog.Close>
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

        {reactions.length > 0 && <section className="ep-sheet-block">
          <h3>Price reaction</h3>
          <div className="ep-reactions">{reactions.map(([label, value]) => <span key={label}><small>{label}</small><b className={tone(value)}>{pct(value, 1)}</b></span>)}</div>
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
      </RadixDialog.Content>
    </RadixDialog.Portal>
  </RadixDialog.Root>;
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
  const [selected, setSelected] = useState<EarningsRecord | null>(null);
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
    for (const [symbol, record] of Object.entries(themes.data?.records ?? {})) map.set(symbol, joinCompanyClassification(map.get(symbol), record));
    return map;
  }, [directory.data, themes.data]);

  const fileQuery = (ref: {sha256: string; url: string; count: number}, enabled = true) => ({
    queryKey: ['earnings-file', ref.sha256], queryFn: () => getEarningsFile(ref), staleTime: Infinity, retry: 1, enabled,
  });
  const seasonFiles = useQueries({queries: (season?.quarters ?? []).map(quarter => fileQuery(index.data!.quarters[quarter].published))});
  const calendarFiles = useQueries({queries: (index.data ? upcomingQuarters(index.data, todayDate) : [])
    .map(quarter => fileQuery(index.data!.quarters[quarter].upcoming, isLatest))});
  // A company's history needs every season; fetched only once a company is opened.
  const historyFiles = useQueries({queries: Object.values(index.data?.quarters ?? {}).map(entry => fileQuery(entry.published, selected !== null))});

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
  const classificationError = lens !== 'grade' ? directory.error ?? (THEME_LEVELS.has(lens) ? themes.error : null) : null;
  const classifying = lens !== 'grade' && (directory.isPending || (THEME_LEVELS.has(lens) && themes.isPending));
  const facets: Facet[] = classifying || classificationError ? [] : lens !== 'grade' ? groupRecords(base, lens, classify)
    : scheduleMode ? TIERS.map(([label]) => ({label, records: base.filter(row => tierOf(row) === label), medianPatYoy: null})).filter(facet => facet.records.length)
    : QUALITY_ORDER.map(grade => {
      const rows = base.filter(row => row.quality === grade);
      return {label: grade, grade, records: rows, medianPatYoy: summarize(rows).medianPatYoy};
    });
  const focused = facets.find(facet => facet.label === focus) ?? null;
  const visible = focused ? focused.records : base;
  const key = (record: EarningsRecord) => sort === 'quality' ? -qualityRank(record.quality) : record[sort];
  const sorted = [...visible].sort((a, b) => {
    const left = key(a), right = key(b);
    if (left == null || right == null) return left == null ? (right == null ? 0 : 1) : -1;
    return typeof left === 'string' ? (right as string).localeCompare(left) : (right as number) - (left as number);
  });
  const summary = summarize(visible);
  const peakFacet = Math.max(1, ...facets.map(facet => facet.records.length));
  const history = selected && !historyFiles.some(file => file.isPending) ? companyHistory(historyFiles.map(file => file.data ?? []), selected.symbol) : null;

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
        <div><dt>Price reaction</dt><dd className={tone(summary.medianReaction)}>{pct(summary.medianReaction, 1)}</dd></div>
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

    <div className="ep-desk">
      <aside className="ep-lens" aria-label="Break down">
        <label className="ep-lens-pick"><span>Break down by</span>
          <span className="ep-lens-select">
            <select value={lens} onChange={event => { setLens(event.target.value as Lens); setFocus(null); }}>
              {LENSES.map(([value, label]) => <option key={value} value={value}>{value === 'grade' && scheduleMode ? 'Size' : label}</option>)}
            </select><ChevronDown size={12} aria-hidden="true" /></span>
        </label>
        {['theme', 'block', 'macro', 'aggregate'].includes(lens) && <p className="ep-lens-state">Groups can overlap. Each company counts once per group.</p>}
        {classificationError ? <p className="ep-lens-state" role="alert">Classifications could not load. <button type="button" onClick={() => {
          void directory.refetch();
          if (THEME_LEVELS.has(lens)) void themes.refetch();
        }}>Retry</button></p> : classifying ? <p className="ep-lens-state" role="status">Loading classification…</p>
          : <ul className="ep-facets">
            {facets.map(facet => <li key={facet.label}>
              <button type="button" aria-pressed={focus === facet.label} data-grade={facet.grade?.toLowerCase()}
                onClick={() => { setFocus(focus === facet.label ? null : facet.label); }}>
                <span className="ep-facet-name">{facet.grade && <i aria-hidden="true" />}{facet.label}</span>
                <span className="ep-facet-count">{facet.records.length}</span>
                {facet.medianPatYoy != null && <span className={`ep-facet-growth ${tone(facet.medianPatYoy)}`}>{pct(facet.medianPatYoy)}</span>}
                <span className="ep-facet-bar" aria-hidden="true"><s style={{width: `${facet.records.length / peakFacet * 100}%`}} /></span>
              </button></li>)}
          </ul>}
      </aside>

      <main className="ep-main">
        <div className="ep-bar">
          <label className="ep-search"><Search size={13} aria-hidden="true" />
            <input type="search" placeholder="Find a company" aria-label="Search company" value={query} onChange={event => { setQuery(event.target.value); }} />
          </label>
          <label className="ep-when" data-active={session ? true : undefined}><Clock size={13} aria-hidden="true" />
            <span className="sr-only">Filing time</span>
            <select value={session ?? ''} onChange={event => { setSession((event.target.value || null) as Session | null); }}>
              <option value="">Any time</option>{SESSIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select><ChevronDown size={12} aria-hidden="true" /></label>
          {focused && <button type="button" className="ep-pill" onClick={() => setFocus(null)}>{focused.label} <X size={11} aria-label="Clear" /></button>}
          <span className="ep-spacer" />
          <span className="ep-count">{sorted.length.toLocaleString('en-IN')} {scheduleMode ? 'scheduled' : 'results'}</span>
        </div>

        {seasonError ? <div className="ep-state" role="alert"><h2>Results could not be loaded</h2><p>{String(seasonError)}</p></div>
          : seasonLoading || classifying ? <p className="ep-state" role="status">Loading…</p>
          : !sorted.length ? <p className="ep-state">Nothing matches. Try another day or clear a filter.</p>
          : scheduleMode ? <ul className="ep-tiles">{sorted.map(record => <li key={record.symbol}>
            <button type="button" className="ep-upcoming" onClick={() => onOpenChart(record.symbol)} title={`Open ${record.symbol} chart`}>
              <SymbolWithLogo symbol={record.symbol} />
              <em>{record.company_name}</em>
              <span>{[record.cap_type && `${record.cap_type} cap`, record.industry ?? record.sector, record.timing && (TIMING[record.timing] ?? record.timing)].filter(Boolean).join(' · ')}</span>
            </button></li>)}</ul>
          : <EarningsResults key={JSON.stringify([season.periodEnd, activeDay, lens, focus, sort, query, session])} records={sorted} onOpen={setSelected}>
            <div className="ep-cols">
              <span>Company</span>{sortButton('quality', 'Grade')}{sortButton('revenue_yoy', 'Sales', 'ep-num')}{sortButton('pat_yoy', 'Profit', 'ep-num')}
              {sortButton('eps_yoy', 'EPS', 'ep-num ep-wide')}{sortButton('post_earnings_pct', 'Reaction', 'ep-num')}{sortButton('filing_day', 'Filed', 'ep-num ep-wide')}
            </div>
          </EarningsResults>}
      </main>
    </div>

    {selected && <Sheet record={selected} history={history} onClose={() => setSelected(null)}
      onOpenChart={() => { const symbol = selected.symbol; setSelected(null); onOpenChart(symbol); }} />}
  </div>;
}
