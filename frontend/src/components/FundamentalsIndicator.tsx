import { useRef, useState, type CSSProperties } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronUp, GripVertical, Settings2, X } from 'lucide-react';
import { screenerApi } from '../api/screenerApi';
import { comparisonPeriod, financialNumber, fundamentalsConfig, growth, priceBandGuides, priceBandLabel, visibleFinancials, type FundamentalsConfig } from '../chart/fundamentals';
import type { ChartMetrics } from './ChartLegend';
import { ChartDialog } from './ChartDialog';
import { Button } from './Button';

const number = new Intl.NumberFormat('en-IN', {maximumFractionDigits: 2});
const format = (value: unknown) => { const n = financialNumber(value); return n === null ? '—' : number.format(n); };
const periodLabel = (date: string) => new Date(`${date}T00:00:00Z`).toLocaleDateString('en-GB', {month: 'short', year: '2-digit', timeZone: 'UTC'});
const metrics = [
  ['sales', 'Sales'], ['expenses', 'Expenses'], ['operating_profit', 'Operating profit'], ['opm', 'OPM %'],
  ['other_income', 'Other income'], ['interest', 'Interest'], ['depreciation', 'Depreciation'],
  ['profit_before_tax', 'Profit before tax'], ['tax_expenses', 'Tax'], ['net_profit', 'Net profit'], ['eps', 'EPS ₹'],
] as const;

export function FundamentalsIndicator({symbol, revision, cutoff, sessionDate, metrics: snapshot, config: raw, onSettings, onRemove, onMove}: {
  symbol: string; revision: string; cutoff: string; sessionDate: string; metrics?: ChartMetrics;
  onMove?: (offset: {x: number; y: number}) => void;
  config: FundamentalsConfig; onSettings: () => void; onRemove: () => void;
}) {
  const config = fundamentalsConfig(raw);
  const [dragOffset, setDragOffset] = useState<{x: number; y: number} | null>(null);
  const drag = useRef<{id: number; x: number; y: number; left: number; top: number; width: number; height: number; offset: {x: number; y: number}} | null>(null);
  const panelPosition = (handle: HTMLElement) => {
    const panel = handle.closest<HTMLElement>('.fundamentals-overlay')!;
    const bounds = panel.getBoundingClientRect(), parent = panel.parentElement!.getBoundingClientRect();
    return {left: bounds.left - parent.left, top: bounds.top - parent.top,
      width: Math.max(1, parent.width - bounds.width), height: Math.max(1, parent.height - bounds.height)};
  };
  const offset = dragOffset ?? config.offset;
  const panelStyle = {'--fundamentals-font': `${config.fontSize}px`, ...(offset ? {
    left: `${offset.x * 100}%`, top: `${offset.y * 100}%`, right: 'auto', bottom: 'auto',
    transform: `translate(${-offset.x * 100}%, ${-offset.y * 100}%)`,
  } : {})} as CSSProperties;
  const [collapsed, setCollapsed] = useState(false);
  const history = useQuery({queryKey: ['financial-history', revision, symbol], queryFn: () => screenerApi.getFinancialHistory(symbol, revision), staleTime: Infinity, retry: false});
  const schedule = useQuery({queryKey: ['earnings-schedule', revision, symbol], queryFn: () => screenerApi.getEarningsSchedule(symbol, revision), staleTime: Infinity, retry: false});
  const rows = visibleFinancials(history.data, config.period, cutoff);
  const shown = rows.slice(0, config.count);
  // Snapshot-only metadata is unavailable before its dated observation during replay.
  const metadata = cutoff >= sessionDate ? snapshot : undefined;
  const surveillance = metadata?.surveillanceAvailable && metadata.surveillanceAsOfDate && metadata.surveillanceAsOfDate <= cutoff
    ? [metadata.isAsm ? `ASM ${metadata.asmStage ?? ''}`.trim() : '', metadata.isGsm ? `GSM ${metadata.gsmStage ?? ''}`.trim() : ''].filter(Boolean) : [];
  const next = schedule.data?.observedOn && schedule.data.observedOn <= cutoff
    ? schedule.data.events.filter(event => event.scheduled_date >= cutoff && /^\d{4}-\d{2}-\d{2}$/.test(event.scheduled_date)).sort((a, b) => a.scheduled_date.localeCompare(b.scheduled_date))[0] : undefined;
  const days = next ? Math.round((Date.parse(next.scheduled_date) - Date.parse(cutoff)) / 86400000) : null;
  const compact = config.layout === 'compact';
  const profit = config.profit === 'eps' ? 'EPS ₹' : 'PAT Cr';
  return <section className={`fundamentals-overlay ${config.position}`} style={panelStyle} aria-label={`${symbol} earnings and price bands`}>
    <header>
      <button type="button" className="fundamentals-drag" aria-label="Move earnings panel" title="Drag to move; use arrow keys to adjust"
        onPointerDown={event => {
          if (event.button !== 0) return;
          event.preventDefault(); event.stopPropagation();
          const position = panelPosition(event.currentTarget);
          drag.current = {id: event.pointerId, x: event.clientX, y: event.clientY, ...position,
            offset: {x: position.left / position.width, y: position.top / position.height}};
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={event => {
          const current = drag.current;
          if (!current || current.id !== event.pointerId) return;
          event.stopPropagation();
          current.offset = {x: Math.max(0, Math.min(1, (current.left + event.clientX - current.x) / current.width)),
            y: Math.max(0, Math.min(1, (current.top + event.clientY - current.y) / current.height))};
          setDragOffset(current.offset);
        }}
        onPointerUp={event => {
          if (drag.current?.id !== event.pointerId) return;
          onMove?.(drag.current.offset); drag.current = null; setDragOffset(null);
          event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={() => {drag.current = null; setDragOffset(null);}}
        onKeyDown={event => {
          const direction = {ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1]}[event.key];
          if (!direction) return;
          event.preventDefault(); event.stopPropagation();
          const position = panelPosition(event.currentTarget), step = event.shiftKey ? 30 : 10;
          onMove?.({x: Math.max(0, Math.min(1, (position.left + direction[0] * step) / position.width)),
            y: Math.max(0, Math.min(1, (position.top + direction[1] * step) / position.height))});
        }}><GripVertical size={13}/><strong>Earnings & Price Bands</strong></button>
      <div>
        <button type="button" aria-label="Earnings and price bands settings" title="Settings" onClick={onSettings}><Settings2 size={13}/></button>
        <button type="button" aria-label={collapsed ? 'Expand earnings table' : 'Collapse earnings table'} onClick={() => setCollapsed(!collapsed)}>{collapsed ? <ChevronDown size={13}/> : <ChevronUp size={13}/>}</button>
        <button type="button" aria-label="Remove Earnings & Price Bands" title="Remove indicator" onClick={onRemove}><X size={13}/></button>
      </div>
    </header>
    {config.band && <div className="fundamentals-badges">
      <span>Band <b>{priceBandLabel(metadata?.circuitLimit)}</b></span>
      {metadata?.isFno && <span>F&O</span>}
      {surveillance.map(label => <span key={label} className="fundamentals-warning">{label}</span>)}
      {next && <span title={`Calendar observed ${schedule.data!.observedOn}${next.date_conflict ? '; source dates disagree' : ''}`}>Results {next.scheduled_date} · {days === 0 ? 'today' : `in ${days}d`}{next.date_conflict ? ' (unconfirmed)' : ''}</span>}
    </div>}
    {!collapsed && <>
      {metadata && <div className="fundamentals-company">{metadata.name || symbol}{metadata.marketCapCrore > 0 && ` · ₹${format(metadata.marketCapCrore)} Cr`}</div>}
      {metadata && <dl className="fundamentals-classification">
        {[['Sector', metadata.sector], ['Industry', metadata.industry], ['Niche', metadata.nicheTags?.join(' · ')]].map(([label, value]) =>
          <div key={label}><dt>{label}</dt><dd>{value && value !== 'Unclassified' ? value : 'Unavailable'}</dd></div>)}
      </dl>}
      <div className="fundamentals-scroll" tabIndex={0} aria-label="Scrollable financial results">
        {shown.length ? <table>
          <caption>{config.period === 'quarterly' ? 'Quarterly' : 'Annual'} · {history.data?.report_type?.toLowerCase()} · ₹ Cr except EPS and %</caption>
          {compact ? <>
            <thead><tr>{['Period', profit, 'YoY %', ...(config.period === 'quarterly' ? ['QoQ %'] : []), 'Sales Cr', 'YoY %', ...(config.period === 'quarterly' ? ['QoQ %'] : []), 'OPM %'].map((label, i) => <th key={i} scope="col">{label}</th>)}</tr></thead>
            <tbody>{shown.map(row => {
              const previousYear = comparisonPeriod(rows, row, 12), previousQuarter = comparisonPeriod(rows, row, 3);
              const values = [financialNumber(row[config.profit]), growth(row[config.profit], previousYear?.[config.profit]),
                ...(config.period === 'quarterly' ? [growth(row[config.profit], previousQuarter?.[config.profit])] : []),
                financialNumber(row.sales), growth(row.sales, previousYear?.sales), ...(config.period === 'quarterly' ? [growth(row.sales, previousQuarter?.sales)] : []), financialNumber(row.opm)];
              return <tr key={row.period_end}><th scope="row">{periodLabel(row.period_end)}</th>{values.map((value, i) => {
                const isGrowth = i === 1 || (config.period === 'quarterly' ? i === 2 || i === 4 || i === 5 : i === 3);
                return <td key={i} data-tone={isGrowth && value !== null ? value > 0 ? 'up' : value < 0 ? 'down' : undefined : undefined}>{format(value)}</td>;
              })}</tr>;
            })}</tbody>
          </> : <>
            <thead><tr><th scope="col">Metric</th>{shown.map(row => <th scope="col" key={row.period_end}>{periodLabel(row.period_end)}</th>)}</tr></thead>
            <tbody>{metrics.filter(([key]) => config.layout === 'results' || ['sales', 'expenses', 'operating_profit', 'opm', 'profit_before_tax', 'net_profit', 'eps'].includes(key)).map(([key, label]) => <tr key={key}><th scope="row">{label}</th>{shown.map(row => <td key={row.period_end}>{format(row[key])}</td>)}</tr>)}</tbody>
          </>}
        </table> : <p role="status">{history.isPending ? 'Loading financial results…' : history.isError ? 'Financial history unavailable for this snapshot.' : `No financial results observed by ${cutoff}.`}</p>}
      </div>
      <footer>{rows.length > 0 ? `${history.data?.source} · observed ${history.data?.observed_on}` : `As of ${cutoff}`}<span>— unavailable</span></footer>
      {config.guides && <p className="fundamentals-guide-note">{metadata && priceBandGuides(metadata.circuitLimit, 1, metadata.isFno).length ? 'Dashed levels: next-session estimates from close × band. Exchange limits may differ.' : 'Band guides unavailable for this date or security.'}</p>}
    </>}
  </section>;
}

export function FundamentalsSettingsDialog({config: raw, onApply, onClose}: {config?: FundamentalsConfig; onApply: (next: FundamentalsConfig) => void; onClose: () => void}) {
  const [config, setConfig] = useState(() => fundamentalsConfig(raw));
  return <ChartDialog title="Earnings & Price Bands settings" onClose={onClose}>
    <form className="fundamentals-settings" onSubmit={event => {event.preventDefault(); onApply(config); onClose();}}>
      <p>Financial results follow the snapshot and replay date. Amounts are in ₹ crore; EPS is ₹ per share.</p>
      <label>Layout<select value={config.layout} onChange={event => setConfig({...config, layout: event.target.value as typeof config.layout})}><option value="compact">Compact growth table</option><option value="essential">Essential results</option><option value="results">Full results</option></select></label>
      <label>Period<select value={config.period} onChange={event => setConfig({...config, period: event.target.value as typeof config.period})}><option value="quarterly">Quarterly</option><option value="annual">Annual</option></select></label>
      <label>Profit metric<select value={config.profit} onChange={event => setConfig({...config, profit: event.target.value as typeof config.profit})}><option value="eps">EPS</option><option value="net_profit">Net profit (PAT)</option></select></label>
      <label>Periods<input type="number" min="3" max="13" value={config.count} onChange={event => setConfig({...config, count: Number(event.target.value)})}/></label>
      <label>Position<select value={config.offset ? 'custom' : config.position} onChange={event => setConfig({...config, position: event.target.value as typeof config.position, offset: null})}>{config.offset && <option value="custom" disabled>Custom (dragged)</option>}<option value="top-right">Top right</option><option value="bottom-right">Bottom right</option><option value="bottom-left">Bottom left</option></select></label>
      <label>Text size<input type="number" min="10" max="15" value={config.fontSize} onChange={event => setConfig({...config, fontSize: Number(event.target.value)})}/></label>
      <label><span>Price band, surveillance and results date</span><input type="checkbox" checked={config.band} onChange={event => setConfig({...config, band: event.target.checked})}/></label>
      <label><span>Earnings filing markers</span><input type="checkbox" checked={config.earningsMarkers} onChange={event => setConfig({...config, earningsMarkers: event.target.checked})}/></label>
      <label><span>Estimated next-session band guides</span><input type="checkbox" checked={config.guides} onChange={event => setConfig({...config, guides: event.target.checked})}/></label>
      <p>Guides use close × band before exchange rounding. They are hidden during historical replay and for F&O securities.</p>
      <footer><Button variant="ghost" onClick={() => setConfig(fundamentalsConfig({enabled: config.enabled}))}>Reset</Button><Button variant="primary" type="submit">Apply</Button></footer>
    </form>
  </ChartDialog>;
}
