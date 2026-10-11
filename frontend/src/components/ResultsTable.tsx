import { useRef, useState } from 'react';
import type { ScreenerRunResponse } from '../types/screener';
import { ArrowUpDown, ArrowUp, ArrowDown, Copy, Check, PlusCircle, AlertTriangle, SearchX, FileText } from 'lucide-react';
import { SymbolWithLogo } from './SymbolWithLogo';
import { AnnouncementsPanel } from './AnnouncementsPanel';
import { Pagination } from './Pagination';

interface ResultsTableProps {
  data?: ScreenerRunResponse;
  isLoading: boolean;
  isError: boolean;
  isFetching?: boolean;
  error?: Error | null;
  onRetry?: () => void;
  onPageChange: (page: number) => void;
  onSortChange: (field: string, direction: 'asc' | 'desc') => void;
  currentSort?: { field: string; direction: 'asc' | 'desc' };
  onAddToWatchlist?: (symbols: string[]) => void;
}

const columns = [
  { label: 'Company', width: '24%' },
  { label: 'Sector / industry', width: '17%' },
  { label: 'Close price', field: 'close', width: '12%' },
  { label: '1D return', field: 'changePct', width: '10%' },
  { label: '20D RVOL', field: 'rvol', width: '9%' },
  { label: 'Market cap (Cr)', field: 'marketCapCrore', width: '12%' },
  { label: 'RS / RSI', width: '8%' },
  { label: 'Delivery', width: '8%' },
];

export function ResultsTable({ data, isLoading, isError, isFetching = false, error, onRetry,
  onPageChange, onSortChange, currentSort, onAddToWatchlist }: ResultsTableProps) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const [filingSymbol, setFilingSymbol] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const resetScroll = () => { if (scrollRef.current) scrollRef.current.scrollTop = 0; };
  const rows = data?.rows ?? [];
  const busy = isLoading || isFetching;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(rows.map(row => `NSE:${row.symbol}`).join(', '));
      setCopyError(false);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { setCopyError(true); }
  };
  return <section className="results-surface" aria-label="Screener results">
    <div className="results-toolbar">
      <div className="result-count"><strong>{data?.matchCount.toLocaleString('en-IN') ?? '-'}</strong><span>matched equities <span className="result-universe">/ {data?.totalUniverseCount.toLocaleString('en-IN') ?? '-'} universe</span></span></div>
      <div className="results-actions">
        <span role="status" className="fetch-status">{busy ? 'Updating results' : data ? 'Results ready' : 'Waiting for data'}</span>
        <button type="button" onClick={() => void copy()} disabled={!rows.length || busy} className="button button-secondary">{copied ? <Check size={15} /> : <Copy size={15} />}<span>{copied ? 'Copied!' : 'Copy TradingView'}</span></button>
        {onAddToWatchlist && <button type="button" onClick={() => onAddToWatchlist(rows.map(row => row.symbol))} disabled={!rows.length || busy} className="button button-secondary"><PlusCircle size={15} /><span>Watchlist</span></button>}
      </div>
    </div>
    {copyError && <p role="alert" className="notice">Clipboard access was denied. Please allow clipboard access and try again.</p>}
    <div className="table-viewport" aria-busy={busy}>
      <div ref={scrollRef} className="table-scroll" tabIndex={0} aria-label="Equity results table, scroll for more columns">
        <table className="data-table">
          <caption className="sr-only">Equities matching the current screen</caption>
          <colgroup>{columns.map(column => <col key={column.label} style={{width: column.width}} />)}</colgroup>
          <thead><tr>{columns.map(column => <th key={column.label} scope="col"
            aria-sort={column.field ? currentSort?.field === column.field ? currentSort.direction === 'asc' ? 'ascending' : 'descending' : 'none' : undefined}>
            {column.field ? <button type="button" disabled={busy} onClick={() => {resetScroll(); onSortChange(column.field!, currentSort?.field === column.field && currentSort.direction === 'asc' ? 'desc' : 'asc');}}>
              {column.label}{currentSort?.field === column.field ? currentSort.direction === 'asc' ? <ArrowUp size={13} /> : <ArrowDown size={13} /> : <ArrowUpDown size={13} />}
            </button> : column.label}
          </th>)}</tr></thead>
          <tbody>
            {isError ? <tr><td colSpan={8}><div className="data-state" role="alert"><AlertTriangle size={28} /><h2>Screener query failed</h2><p>{error?.message || 'The query could not be completed.'}</p>{onRetry && <button className="button button-secondary" onClick={onRetry}>Retry</button>}</div></td></tr>
              : !data ? Array.from({length: 10}, (_, i) => <tr key={i} className="skeleton-row">{columns.map(column => <td key={column.label}><span className="skeleton" /></td>)}</tr>)
              : !rows.length ? <tr><td colSpan={8}><div className="data-state"><SearchX size={28} /><h2>No equities matched</h2><p>Adjust your filters or choose a broader universe.</p></div></td></tr>
              : rows.map(row => <tr key={row.symbol}>
                <td><div className="company-cell"><SymbolWithLogo symbol={row.symbol} name={row.name} />
                  <div className="company-tools">{row.isFno && <span className="fno-label">F&O</span>}<button type="button" className="icon-button filing-button" aria-label={`View ${row.symbol} announcements`} title="View announcements" onClick={() => setFilingSymbol(row.symbol)} disabled={busy}><FileText size={15} /></button></div></div></td>
                <td><div className={row.sector === 'Unclassified' ? 'cell-muted truncate' : 'cell-label truncate'} title={row.sector}>{row.sector}</div><div className="cell-secondary truncate" title={row.industry}>{row.industry}</div></td>
                <td className="numeric cell-strong">₹{row.close.toLocaleString('en-IN', {minimumFractionDigits: 2})}</td>
                <td className={`numeric ${row.changePct == null ? 'cell-muted' : row.changePct >= 0 ? 'positive' : 'negative'}`}>{row.changePct == null ? 'N/A' : `${row.changePct >= 0 ? '+' : ''}${row.changePct.toFixed(2)}%`}</td>
                <td className="numeric"><span className={row.rvol != null && row.rvol >= 2 ? 'volume-badge' : ''}>{row.rvol == null ? 'N/A' : `${row.rvol.toFixed(2)}x`}</span></td>
                <td className="numeric">{row.marketCapCrore == null ? 'N/A' : `₹${Math.round(row.marketCapCrore).toLocaleString('en-IN')} Cr`}</td>
                <td className="numeric"><span className="cell-strong">{row.rsRating ?? 'N/A'}</span><span className="cell-secondary block">RSI {row.rsi14 ?? 'N/A'}</span></td>
                <td className="numeric">{row.deliveryPct == null ? <span className="cell-muted">Unavailable</span> : `${row.deliveryPct}%`}</td>
              </tr>)}
          </tbody>
        </table>
      </div>
      <Pagination page={data?.page ?? 1} pageSize={data?.pageSize ?? 15} total={data?.matchCount ?? 0} busy={busy || isError || !data} onPageChange={page => {resetScroll(); onPageChange(page);}} />
    </div>
    {filingSymbol && data && <AnnouncementsPanel key={`${filingSymbol}:${data.immutableRevision}`} symbol={filingSymbol} revision={data.immutableRevision} onClose={() => setFilingSymbol(null)} />}
  </section>;
}
