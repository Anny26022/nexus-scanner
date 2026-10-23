import { memo, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { screenerApi } from '../api/screenerApi';
import {
  BAND_MARKERS, comparisonPeriod, financialNumber, fundamentalsConfig, growth, priceBandPercent, resultsCountdown, surveillanceLabels, upcomingResults, visibleFinancials,
  type FinancialPeriod, type FundamentalsConfig,
} from '../chart/fundamentals';
import type { ChartMetrics } from './ChartLegend';
import { ChartDialog } from './ChartDialog';
import { Button } from './Button';
import { MarkerStyleRow } from './MarkerStyleRow';
import { markerStyle } from '../chart/markerShapes';
import { useMountEffect } from '../hooks/useMountEffect';

type Offset = {x: number; y: number};
const croreFormat = new Intl.NumberFormat('en-IN', {maximumFractionDigits: 0});
const decimalFormat = new Intl.NumberFormat('en-IN', {maximumFractionDigits: 1});
// Values that round to zero print "0", never "-0".
const crore = {format: (value: number) => croreFormat.format(Math.round(value) || 0)};
const decimal = {format: (value: number) => decimalFormat.format(Math.round(value * 10) / 10 || 0)};
const periodLabel = (date: string) => new Date(`${date}T00:00:00Z`).toLocaleDateString('en-US', {month: 'short', year: '2-digit', timeZone: 'UTC'}).replace(' ', '-');
/** Whole-number % change like the extension: +12%, -8%, 0%. */
const change = (value: number | null) => value === null ? null : Math.round(value);

const RESULT_ROWS = [
  ['sales', 'Sales'], ['expenses', 'Expenses'], ['operating_profit', 'Operating Profit'], ['opm', 'OPM %'],
  ['other_income', 'Other Income'], ['interest', 'Interest'], ['depreciation', 'Depreciation'],
  ['profit_before_tax', 'Profit before tax'], ['tax_expenses', 'Tax'], ['net_profit', 'Net Profit'], ['eps', 'EPS in Rs'],
] as const;
const ESSENTIAL = new Set(['sales', 'expenses', 'operating_profit', 'opm', 'profit_before_tax', 'net_profit', 'eps']);
const LOWER_IS_BETTER = new Set(['expenses', 'interest', 'depreciation', 'tax_expenses']);

/** Drag the badge or card handle; arrow keys nudge a focused overlay. */
export function useOverlayDrag(onMove?: (offset: Offset) => void) {
  const [live, setLive] = useState<Offset | null>(null);
  const frame = useRef(0);
  useMountEffect(() => () => cancelAnimationFrame(frame.current));
  const drag = useRef<{id: number; x: number; y: number; left: number; top: number; width: number; height: number; offset: Offset; moved: boolean} | null>(null);
  const measure = (element: HTMLElement) => {
    const bounds = element.getBoundingClientRect(), parent = element.parentElement!.getBoundingClientRect();
    return {left: bounds.left - parent.left, top: bounds.top - parent.top,
      width: Math.max(1, parent.width - bounds.width), height: Math.max(1, parent.height - bounds.height)};
  };
  const clamp = (value: number) => Math.max(0, Math.min(1, value));
  return {
    live,
    handlers: {
      onPointerDown: (event: PointerEvent<HTMLElement>) => {
        const target = event.target as HTMLElement;
        if (event.button !== 0 || target.closest('button')) return;
        if (event.currentTarget.classList.contains('pb-card') && !target.closest('.pb-drag-handle')) return;
        event.preventDefault(); event.stopPropagation();
        const position = measure(event.currentTarget);
        drag.current = {id: event.pointerId, x: event.clientX, y: event.clientY, ...position, offset: {x: position.left / position.width, y: position.top / position.height}, moved: false};
        event.currentTarget.setPointerCapture(event.pointerId);
      },
      onPointerMove: (event: PointerEvent<HTMLElement>) => {
        const current = drag.current;
        if (!current || current.id !== event.pointerId) return;
        event.stopPropagation();
        current.moved ||= Math.abs(event.clientX - current.x) + Math.abs(event.clientY - current.y) > 3;
        current.offset = {x: clamp((current.left + event.clientX - current.x) / current.width), y: clamp((current.top + event.clientY - current.y) / current.height)};
        if (current.moved && !frame.current) frame.current = requestAnimationFrame(() => { frame.current = 0; setLive(drag.current?.offset ?? null); });
      },
      onPointerUp: (event: PointerEvent<HTMLElement>) => {
        const current = drag.current;
        if (current?.id !== event.pointerId) return;
        if (current.moved) onMove?.(current.offset);
        cancelAnimationFrame(frame.current); frame.current = 0; drag.current = null; setLive(null);
        event.currentTarget.releasePointerCapture(event.pointerId);
      },
      onPointerCancel: () => { cancelAnimationFrame(frame.current); frame.current = 0; drag.current = null; setLive(null); },
      onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
        const direction = ({ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1]} as Record<string, number[]>)[event.key];
        if (!direction || event.target !== event.currentTarget) return;
        event.preventDefault(); event.stopPropagation();
        const position = measure(event.currentTarget), step = event.shiftKey ? 30 : 10;
        onMove?.({x: clamp((position.left + direction[0] * step) / position.width), y: clamp((position.top + direction[1] * step) / position.height)});
      },
    },
  };
}
export const placed = (offset: Offset | null, extra: CSSProperties = {}): CSSProperties => offset ? {
  ...extra, left: `${offset.x * 100}%`, top: `${offset.y * 100}%`, right: 'auto', bottom: 'auto',
  translate: `${-offset.x * 100}% ${-offset.y * 100}%`,
} : extra;

export function FundamentalsIndicator({symbol, revision, cutoff, sessionDate, metrics: snapshot, config: raw, onMoveBadge, onMove}: {
  symbol: string; revision: string; cutoff: string; sessionDate: string; metrics?: ChartMetrics; config: FundamentalsConfig;
  onMoveBadge?: (offset: Offset) => void; onMove?: (offset: Offset) => void;
}) {
  const config = useMemo(() => fundamentalsConfig(raw), [raw]);
  const badgeDrag = useOverlayDrag(onMoveBadge);
  const cardDrag = useOverlayDrag(onMove);
  const history = useQuery({queryKey: ['financial-history', revision, symbol], queryFn: () => screenerApi.getFinancialHistory(symbol, revision), staleTime: Infinity, retry: false, enabled: config.table});
  const schedule = useQuery({queryKey: ['earnings-schedule', revision, symbol], queryFn: () => screenerApi.getEarningsSchedule(symbol, revision), staleTime: Infinity, retry: false, enabled: config.band && config.resultDate});

  // Snapshot-only metadata is unavailable before its dated observation during replay.
  const metadata = cutoff >= sessionDate ? snapshot : undefined;
  const surveillance = metadata?.surveillanceAvailable && metadata.surveillanceAsOfDate && metadata.surveillanceAsOfDate <= cutoff ? surveillanceLabels(metadata) : [];
  // Within 90 days, like the reference script.
  const next = upcomingResults(schedule.data, cutoff);
  const band = priceBandPercent(metadata?.circuitLimit);
  const fno = Boolean(metadata?.isFno);
  const bandText = band !== null ? `${band}%` : fno ? 'F&O' : 'NB';
  const bandTone = band === 20 ? '20' : band === 10 ? '10' : band !== null && band <= 5 ? '5' : 'none';
  const countdown = next && config.resultDate ? resultsCountdown(next.scheduled_date, cutoff) : '';
  const bandTitle = [
    band !== null ? `Price band ${band}%` : fno ? 'F&O stock: no price band' : 'No price band',
    next ? `Results ${next.scheduled_date}${next.date_conflict ? ' (sources disagree)' : ''}` : '',
    ...surveillance.map(label => `Surveillance: ${label}`),
  ].filter(Boolean).join('\n');

  const rows = useMemo(() => config.table ? visibleFinancials(history.data, config.period, cutoff) : [], [history.data, config.table, config.period, cutoff]);
  const shown = useMemo(() => rows.slice(0, config.count), [rows, config.count]);

  return <>
    {config.band && metadata && <div className="pb-badge" role="group" tabIndex={0} aria-label={`${symbol} price band`} title={`${bandTitle}\nDrag to move`}
      style={placed(badgeDrag.live ?? config.badgeOffset, {'--pb-scale': config.badgeScale} as CSSProperties)} {...badgeDrag.handlers}>
      <span className="pb-band" data-band={bandTone}>
        <b>{bandText}</b>
        {countdown && <span className="pb-days">{countdown}</span>}
      </span>
      {surveillance.map(label => <span key={label} className="pb-status">{label}</span>)}
    </div>}
    {/* No card at all while loading or when nothing is published: an empty table only covers the chart. */}
    {config.table && shown.length > 0 && <section className={`pb-card${config.layout === 'compact' ? '' : ' is-results'}`} tabIndex={0} aria-label={`${symbol} results`} title="Drag the handle to move; arrow keys nudge when focused"
      style={placed(cardDrag.live ?? config.offset, {'--pb-scale': config.tableScale} as CSSProperties)} {...cardDrag.handlers}>
      <div className="pb-drag-handle" aria-hidden="true">•••</div>
      {config.layout === 'compact'
        ? <CompactTable rows={rows} shown={shown} config={config} metadata={metadata} />
        : <ResultsTable shown={shown} config={config} metadata={metadata} />}
    </section>}
  </>;
}

function Meta({metadata, children}: {metadata?: ChartMetrics; children?: ReactNode}) {
  const cap = metadata?.marketCapCrore;
  const float = metadata?.freeFloatPct;
  // Listing dates arrive as "06-OCT-2008" or ISO; only the year is shown.
  const listed = metadata?.listingDate?.match(/\b(?:19|20)\d{2}\b/)?.[0] ?? '';
  const parts = [
    cap && cap > 0 ? `MCAP ${crore.format(cap)} CR` : '',
    cap && cap > 0 && typeof float === 'number' && float > 0 && float <= 100 ? `FF ${crore.format(cap * float / 100)} CR` : '',
    listed ? `LISTED ${listed}` : '',
  ].filter(Boolean);
  if (!parts.length && !children) return null;
  return <div className="pb-meta">{parts.join(' | ')}{children}</div>;
}

function ChangeCell({value}: {value: number | null}) {
  const rounded = change(value);
  if (rounded === null) return <td className="pb-change" data-trend="flat">—</td>;
  return <td className="pb-change" data-trend={rounded > 0 ? 'up' : rounded < 0 ? 'down' : 'flat'}>{rounded > 0 ? `+${rounded}` : rounded}%</td>;
}

const CompactTable = memo(function CompactTable({rows, shown, config, metadata}: {rows: FinancialPeriod[]; shown: FinancialPeriod[]; config: Required<FundamentalsConfig>; metadata?: ChartMetrics}) {
  const quarterly = config.period === 'quarterly';
  const profit = config.profit;
  const summary = [metadata?.sector, metadata?.industry].filter(value => value && value !== 'Unclassified').join(' | ');
  const value = (row: FinancialPeriod, key: string, digits = false) => {
    const n = financialNumber(row[key]);
    return n === null ? '—' : digits ? decimal.format(n) : crore.format(n);
  };
  return <>
    <Meta metadata={metadata} />
    {summary && <div className="pb-summary">{summary}</div>}
    <table className="pb-table">
      <thead><tr>
        <th scope="col">{quarterly ? 'FQ' : 'FY'}</th>
        <th scope="col">{profit === 'eps' ? 'EPS' : 'PAT'}</th><th scope="col">YoY</th>{quarterly && <th scope="col">QoQ</th>}
        <th scope="col">Sales</th><th scope="col">YoY</th>{quarterly && <th scope="col">QoQ</th>}
      </tr></thead>
      <tbody>{shown.map(row => {
        const year = comparisonPeriod(rows, row, 12), quarter = comparisonPeriod(rows, row, 3);
        return <tr key={row.period_end}>
          <th scope="row">{periodLabel(row.period_end)}</th>
          <td>{value(row, profit, profit === 'eps')}</td>
          <ChangeCell value={growth(row[profit], year?.[profit])} />
          {quarterly && <ChangeCell value={growth(row[profit], quarter?.[profit])} />}
          <td>{value(row, 'sales')}</td>
          <ChangeCell value={growth(row.sales, year?.sales)} />
          {quarterly && <ChangeCell value={growth(row.sales, quarter?.sales)} />}
        </tr>;
      })}</tbody>
    </table>
  </>;
});

/** Screener-style results grid, oldest period first; a value beyond every earlier one is highlighted. */
const ResultsTable = memo(function ResultsTable({shown, config, metadata}: {shown: FinancialPeriod[]; config: Required<FundamentalsConfig>; metadata?: ChartMetrics}) {
  const periods = [...shown].reverse();
  const keys = RESULT_ROWS.filter(([key]) => (config.layout === 'results' || ESSENTIAL.has(key)) && periods.some(row => financialNumber(row[key]) !== null));
  return <>
    <Meta metadata={metadata} />
    <table className="pb-results">
      <thead><tr><th scope="col" />{periods.map(row => <th scope="col" key={row.period_end}>{periodLabel(row.period_end)}</th>)}</tr></thead>
      <tbody>{keys.map(([key, label]) => {
        const values = periods.map(row => financialNumber(row[key]));
        return <tr key={key}><th scope="row">{label}</th>{values.map((current, index) => {
          const earlier = values.slice(0, index).filter((n): n is number => n !== null);
          let tone: 'up' | 'down' | undefined;
          if (current !== null && earlier.length) {
            const higher = current > Math.max(...earlier), lower = current < Math.min(...earlier);
            tone = LOWER_IS_BETTER.has(key) ? lower ? 'up' : higher ? 'down' : undefined : higher ? 'up' : lower ? 'down' : undefined;
          }
          const text = current === null ? '—' : key === 'eps' || key === 'opm' ? decimal.format(current) : crore.format(current);
          return <td key={periods[index].period_end} data-breakout={tone}>{text}{key === 'opm' && current !== null ? '%' : ''}</td>;
        })}</tr>;
      })}</tbody>
    </table>
  </>;
});

export function FundamentalsSettingsDialog({config: raw, onApply, onClose}: {config?: FundamentalsConfig; onApply: (next: FundamentalsConfig) => void; onClose: () => void}) {
  const [config, setConfig] = useState(() => fundamentalsConfig(raw));
  const set = (change: Partial<FundamentalsConfig>) => setConfig(current => ({...current, ...change}));
  const check = (key: 'band' | 'resultDate' | 'table' | 'guides' | 'earningsMarkers' | 'earningsLabel' | 'earningsLine' | 'bandHistory', label: string, disabled = false) =>
    <label className="pb-setting-check"><input type="checkbox" checked={config[key]} disabled={disabled} onChange={event => set({[key]: event.target.checked})} /><span>{label}</span></label>;
  return <ChartDialog title="Price Band & Results" onClose={onClose} className="pb-settings-dialog">
    <form className="pb-settings" onSubmit={event => { event.preventDefault(); onApply(config); onClose(); }}>
      <h4>Price band</h4>
      {check('band', 'Price band badge (band, ASM/GSM)')}
      {check('resultDate', 'Results countdown in the badge', !config.band)}
      {check('bandHistory', 'Past band changes on the chart')}
      {config.bandHistory && <div className="pb-band-styles">
        {BAND_MARKERS.map(([key, label, color]) => <MarkerStyleRow key={key} label={label}
          style={markerStyle(config.bandStyles[key], {visible: true, color, shape: 'square'})}
          onChange={next => set({bandStyles: {...config.bandStyles, [key]: next}})} />)}
      </div>}
      {check('guides', 'Upper and lower circuit lines (UC / LC)')}
      {check('earningsLabel', 'Upcoming results "E" label on the chart')}
      {check('earningsLine', 'Dotted line on the results date', !config.earningsLabel)}
      {check('earningsMarkers', 'Earnings filing markers on candles')}
      <label className="pb-setting-row">Badge size
        <input type="range" min={0.8} max={1.5} step={0.05} value={config.badgeScale} disabled={!config.band} onChange={event => set({badgeScale: Number(event.target.value)})} />
        <output>{Math.round(config.badgeScale * 100)}%</output></label>
      <h4>Results table</h4>
      {check('table', 'Show results table')}
      <label className="pb-setting-row">Layout
        <select value={config.layout} disabled={!config.table} onChange={event => set({layout: event.target.value as typeof config.layout})}>
          <option value="compact">Compact (EPS / Sales growth)</option><option value="essential">Essential results</option><option value="results">Full results</option>
        </select></label>
      <label className="pb-setting-row">Period
        <select value={config.period} disabled={!config.table} onChange={event => set({period: event.target.value as typeof config.period})}>
          <option value="quarterly">Quarterly</option><option value="annual">Annual</option>
        </select></label>
      <label className="pb-setting-row">Profit
        <select value={config.profit} disabled={!config.table || config.layout !== 'compact'} onChange={event => set({profit: event.target.value as typeof config.profit})}>
          <option value="eps">EPS</option><option value="net_profit">Net profit (PAT)</option>
        </select></label>
      <label className="pb-setting-row">Periods
        <input type="number" min={3} max={13} value={config.count} disabled={!config.table} onChange={event => set({count: Number(event.target.value)})} /></label>
      <label className="pb-setting-row">Table size
        <input type="range" min={0.8} max={1.5} step={0.05} value={config.tableScale} disabled={!config.table} onChange={event => set({tableScale: Number(event.target.value)})} />
        <output>{Math.round(config.tableScale * 100)}%</output></label>
      <p className="pb-settings-note">Drag the badge or table handle to move them; arrow keys nudge a focused one. UC/LC are the latest close × band, before exchange rounding, and are hidden in replay and for F&O stocks.</p>
      <footer>
        <Button variant="ghost" onClick={() => setConfig(fundamentalsConfig({enabled: config.enabled}))}>Reset</Button>
        <div className="flex gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="primary" type="submit">Apply</Button></div>
      </footer>
    </form>
  </ChartDialog>;
}
