import { useRef, useState } from 'react';
import type { ScreenerRunResponse } from '../types/screener';
import { ArrowUpDown, ArrowUp, ArrowDown, AlertTriangle, SearchX, FileText, SlidersHorizontal, Search, Table2, ChartNoAxesCombined, X } from 'lucide-react';
import {CopyResults} from './CopyResults';
import {DownloadResults} from './DownloadResults';
import { SymbolWithLogo } from './SymbolWithLogo';
import { AnnouncementsPanel } from './AnnouncementsPanel';
import { Pagination } from './Pagination';
import { Dialog } from './Dialog';
import { useLocalStorageState } from '../hooks/useLocalStorageState';
import { useSymbolHoverCard } from '../hooks/useSymbolHoverCard';
import { TijoriDetailsCard } from './TijoriDetailsCard';
import { usePhoneLayout } from '../hooks/usePhoneLayout';
import { tableLayout } from '../utils/tableLayout';
import { tradingViewMetrics } from '../data/tradingViewMetrics';
import { QuickChartsView } from './QuickChartsView';

interface ResultsTableProps {
  loadExportRows?:()=>Promise<ScreenerRunResponse['rows']>;
  symbolSearch?: string;
  onSymbolSearchChange?: (value: string) => void;
  data?: ScreenerRunResponse;
  isLoading: boolean;
  isError: boolean;
  isFetching?: boolean;
  error?: Error | null;
  onRetry?: () => void;
  onPageChange: (page: number) => void;
  onPageSizeChange?: (size: number) => void;
  page?: number;
  pageSize?: number;
  onSortChange: (field: string, direction: 'asc' | 'desc') => void;
  currentSort?: { field: string; direction: 'asc' | 'desc' };
  onOpenFullChart?: (symbol: string, revision?: string) => void;
  resultView?: 'table' | 'charts';
  onResultViewChange?: (view: 'table' | 'charts') => void;
}

type ColumnGroup = 'Overview' | 'Technical' | 'Fundamental' | 'Other';
type ColumnValue = string | number | boolean | null | undefined;
interface ResultColumn {
  id: string;
  label: string;
  group: ColumnGroup;
  getValue: (row: ScreenerRunResponse['rows'][number]) => ColumnValue;
  format?: 'number' | 'percent' | 'multiple' | 'crore' | 'boolean' | 'price';
  sortField?: string;
  width?: string;
}

const valueColumn = (id: string, label: string, group: ColumnGroup, format: ResultColumn['format'] = 'number', sortField?: string): ResultColumn => ({
  id, label, group, format, sortField, getValue: row => (row as unknown as Record<string, ColumnValue>)[id],
});
const metricColumn = (id: string, label: string, format: ResultColumn['format'] = 'number'): ResultColumn => ({
  id, label, group: 'Technical', format,
  getValue: row => ((row as unknown as {metrics?: Record<string, ColumnValue>}).metrics?.[id]),
});

const columns: ResultColumn[] = [
  { id: 'company', label: 'Company', group: 'Overview', width: '24%', getValue: row => row.symbol },
  { id: 'sector', label: 'Sector / industry', group: 'Overview', width: '17%', getValue: row => `${row.sector || 'Unclassified'} · ${row.industry || 'Unclassified'}` },
  {...valueColumn('close', 'Close price', 'Technical', 'price', 'close'), width: '12%'},
  {...valueColumn('changePct', '1D return', 'Technical', 'percent', 'changePct'), width: '10%'},
  {...valueColumn('rvol', '20D RVOL', 'Technical', 'multiple', 'rvol'), width: '9%'},
  {...valueColumn('marketCapCrore', 'Market cap (Cr)', 'Fundamental', 'crore', 'marketCapCrore'), width: '12%'},
  { id: 'rsRsi', label: 'RS / RSI', group: 'Technical', width: '8%', getValue: row => `${row.rsRating ?? '—'} / ${row.rsi14 ?? '—'}` },
  valueColumn('rsRating', 'RS rating', 'Technical'),
  {...valueColumn('deliveryPct', 'Delivery', 'Technical', 'percent'), width: '8%'},
  valueColumn('open', 'Open', 'Technical'), valueColumn('high', 'High', 'Technical'), valueColumn('low', 'Low', 'Technical'),
  valueColumn('volume', 'Volume', 'Technical'), valueColumn('rupeeVolumeCrore', 'Turnover (Cr)', 'Technical', 'crore'),
  valueColumn('rsi14', 'RSI (14)', 'Technical'), valueColumn('adr20Pct', 'ADR (20D)', 'Technical', 'percent'),
  valueColumn('atr14', 'ATR (14)', 'Technical'),
  metricColumn('sma10', 'SMA10'), ...(['sma20','sma50','sma200','ema20','ema50','ema200'] as const).map(id => valueColumn(id, id.toUpperCase(), 'Technical')),
  valueColumn('dist52wHighPct', 'From 52W high', 'Technical', 'percent'), valueColumn('dist52wLowPct', 'From 52W low', 'Technical', 'percent'),
  valueColumn('distAthPct', 'From all-time high', 'Technical', 'percent'), valueColumn('allTimeHigh', 'All-time high', 'Technical'),
  valueColumn('allTimeLow', 'All-time low', 'Technical'), valueColumn('return5yPct', 'Return (5Y)', 'Technical', 'percent'),
  valueColumn('vwap', 'VWAP', 'Technical'),
  ...(['return5','return21','return63','return126','return252'] as const).map(id => metricColumn(id, `${id.slice(6)}D return`, 'percent')),
  ...(['turnover20','turnover50','turnover100'] as const).map(id => metricColumn(id, `${id.slice(8)}D avg turnover (Cr)`, 'crore')),
  metricColumn('gapPct', 'Gap', 'percent'),
  valueColumn('peRatio', 'P/E', 'Fundamental'), valueColumn('pbRatio', 'P/B', 'Fundamental'), valueColumn('pegRatio', 'PEG', 'Fundamental'),
  valueColumn('evEbitda', 'EV / EBITDA', 'Fundamental'), valueColumn('epsTtm', 'EPS (TTM)', 'Fundamental'),
  valueColumn('dividendYieldPct', 'Dividend yield', 'Fundamental', 'percent'), valueColumn('dividendPerShare', 'Dividend / share', 'Fundamental'),
  valueColumn('roePct', 'ROE', 'Fundamental', 'percent'), valueColumn('rocePct', 'ROCE', 'Fundamental', 'percent'),
  valueColumn('roaPct', 'ROA', 'Fundamental', 'percent'), valueColumn('opmTtmPct', 'OPM (TTM)', 'Fundamental', 'percent'),
  valueColumn('debtToEquity', 'Debt / equity', 'Fundamental'), valueColumn('currentRatio', 'Current ratio', 'Fundamental'),
  valueColumn('interestCoverage', 'Interest coverage', 'Fundamental'), valueColumn('promoterHoldingPct', 'Promoter holding', 'Fundamental', 'percent'),
  valueColumn('fiiHoldingPct', 'FII holding', 'Fundamental', 'percent'), valueColumn('diiHoldingPct', 'DII holding', 'Fundamental', 'percent'),
  valueColumn('fiiChangePctQoq', 'FII holding change (QoQ)', 'Fundamental', 'percent'),
  valueColumn('diiChangePctQoq', 'DII holding change (QoQ)', 'Fundamental', 'percent'),
  valueColumn('ttmRevenueCrore', 'Revenue (TTM, Cr)', 'Fundamental', 'crore'), valueColumn('ttmSalesCrore', 'Sales (TTM, Cr)', 'Fundamental', 'crore'),
  valueColumn('ttmNetProfitCrore', 'Net profit (TTM, Cr)', 'Fundamental', 'crore'),
  valueColumn('ttmRevenueGrowthPct', 'Revenue growth (TTM)', 'Fundamental', 'percent'),
  valueColumn('ttmSalesGrowthPct', 'Sales growth (TTM)', 'Fundamental', 'percent'),
  valueColumn('ttmNetProfitGrowthPct', 'Profit growth (TTM)', 'Fundamental', 'percent'),
  valueColumn('salesGrowth5yPct', 'Sales growth (5Y)', 'Fundamental', 'percent'), valueColumn('epsGrowth1yPct', 'EPS growth (1Y)', 'Fundamental', 'percent'),
  valueColumn('epsCagr3yPct', 'EPS CAGR (3Y)', 'Fundamental', 'percent'), valueColumn('revenueCagr3yPct', 'Revenue CAGR (3Y)', 'Fundamental', 'percent'),
  valueColumn('opm5YearsAgoPct', 'OPM (5Y ago)', 'Fundamental', 'percent'),
  valueColumn('averageRoe3yPct', 'Average ROE (3Y)', 'Fundamental', 'percent'), valueColumn('averageRoa3yPct', 'Average ROA (3Y)', 'Fundamental', 'percent'),
  valueColumn('averageOpm5yPct', 'Average OPM (5Y)', 'Fundamental', 'percent'), valueColumn('medianSalesGrowth5yPct', 'Median sales growth (5Y)', 'Fundamental', 'percent'),
  valueColumn('freeCashFlowCrore', 'Free cash flow (Cr)', 'Fundamental', 'crore'), valueColumn('borrowingsCrore', 'Borrowings (Cr)', 'Fundamental', 'crore'),
  valueColumn('cwipCrore', 'Capital work in progress (Cr)', 'Fundamental', 'crore'), valueColumn('fixedAssetsCrore', 'Fixed assets (Cr)', 'Fundamental', 'crore'),
  valueColumn('financingCashFlowCrore', 'Financing cash flow (Cr)', 'Fundamental', 'crore'),
  valueColumn('totalRevenueLakh', 'Total revenue (Lakh)', 'Fundamental'), valueColumn('totalIncomeLakh', 'Total income (Lakh)', 'Fundamental'),
  valueColumn('totalExpenseLakh', 'Total expense (Lakh)', 'Fundamental'), valueColumn('profitBeforeTaxLakh', 'Profit before tax (Lakh)', 'Fundamental'),
  valueColumn('totalTaxExpensesLakh', 'Tax expense (Lakh)', 'Fundamental'), valueColumn('netProfitLakh', 'Net profit (Lakh)', 'Fundamental'),
  valueColumn('totalEquityLakh', 'Total equity (Lakh)', 'Fundamental'), valueColumn('totalAssetsLakh', 'Total assets (Lakh)', 'Fundamental'),
  valueColumn('currentAssetsLakh', 'Current assets (Lakh)', 'Fundamental'), valueColumn('currentLiabilitiesLakh', 'Current liabilities (Lakh)', 'Fundamental'),
  valueColumn('nonCurrentAssetsLakh', 'Non-current assets (Lakh)', 'Fundamental'), valueColumn('nonCurrentLiabilitiesLakh', 'Non-current liabilities (Lakh)', 'Fundamental'),
  valueColumn('totalLiabilitiesLakh', 'Total liabilities (Lakh)', 'Fundamental'), valueColumn('operatingCashFlowLakh', 'Operating cash flow (Lakh)', 'Fundamental'),
  valueColumn('investingCashFlowLakh', 'Investing cash flow (Lakh)', 'Fundamental'), valueColumn('netCashFlowLakh', 'Net cash flow (Lakh)', 'Fundamental'),
  valueColumn('industryPeRatio', 'Industry P/E', 'Fundamental'), valueColumn('publicHoldingPct', 'Public holding', 'Fundamental', 'percent'),
  valueColumn('numberOfShareholders', 'Shareholder count', 'Fundamental'), valueColumn('faceValue', 'Face value', 'Fundamental', 'price'),
  valueColumn('epsLastYear', 'EPS (last year)', 'Fundamental'), valueColumn('epsTwoYearsBack', 'EPS (2Y ago)', 'Fundamental'),
  valueColumn('listingDate', 'Listing date', 'Other'), valueColumn('dividendExDate', 'Dividend ex-date', 'Other'), valueColumn('earningsDate', 'Earnings date', 'Other'),
  valueColumn('daysSinceEarnings', 'Days since earnings', 'Other'), valueColumn('series', 'Series', 'Other'),
  valueColumn('isFno', 'F&O eligible', 'Other', 'boolean'), valueColumn('fnoBan', 'F&O ban', 'Other', 'boolean'),
  valueColumn('circuitLimit', 'Circuit limit', 'Other'), valueColumn('dataCompleteness', 'Data completeness', 'Other', 'percent'),
  valueColumn('isAsm', 'ASM', 'Other', 'boolean'), valueColumn('asmStage', 'ASM stage', 'Other'),
  valueColumn('isGsm', 'GSM', 'Other', 'boolean'), valueColumn('gsmStage', 'GSM stage', 'Other'),
  valueColumn('surveillanceAvailable', 'Surveillance data available', 'Other', 'boolean'),
  ...tradingViewMetrics.map((metric):ResultColumn => ({id:`tv.${metric.id}`, label:metric.label,
    group:metric.category === 'fundamentals' ? 'Fundamental' : 'Technical',
    getValue:row => row.tradingview?.values[metric.id]})),
];
const DEFAULT_COLUMNS = ['company','sector','close','changePct','rvol','marketCapCrore','rsRsi','deliveryPct'];
const COLUMN_GROUPS: ColumnGroup[] = ['Overview','Technical','Fundamental','Other'];
const numberFormatter = new Intl.NumberFormat('en-IN', {maximumFractionDigits: 2});
const priceFormatter = new Intl.NumberFormat('en-IN', {minimumFractionDigits: 2, maximumFractionDigits: 2});

const displayValue = (value: ColumnValue, format?: ResultColumn['format']) => {
  if (value == null || value === '') return <span className="cell-muted">—</span>;
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return <span className="cell-muted">—</span>;
    if (format === 'price') return `₹${priceFormatter.format(value)}`;
    const formatted = numberFormatter.format(value);
    if (format === 'percent') return `${formatted}%`;
    if (format === 'multiple') return `${formatted}×`;
    if (format === 'crore') return `₹${formatted} Cr`;
    return formatted;
  }
  return value;
};

export function ResultsTable({ data, isLoading, isError, isFetching = false, error, onRetry,
  onPageChange, onPageSizeChange, page, pageSize, onSortChange, currentSort, symbolSearch = '', onSymbolSearchChange, loadExportRows, onOpenFullChart,
  resultView: propResultView, onResultViewChange }: ResultsTableProps) {
  const [filingSymbol, setFilingSymbol] = useState<string | null>(null);
  const [columnPickerOpen, setColumnPickerOpen] = useState(false);
  const [internalResultView, setInternalResultView] = useLocalStorageState<'table' | 'charts'>('nexus-scanner.screener.result-view.v1', 'table');
  const resultView = propResultView ?? internalResultView;
  const setResultView = onResultViewChange ?? setInternalResultView;
  const [chartsMounted, setChartsMounted] = useState(resultView === 'charts');
  if (resultView === 'charts' && !chartsMounted) {
    setChartsMounted(true);
  }
  const handleResultViewChange = (view: 'table' | 'charts') => {
    setResultView(view);
    if (view === 'charts' && typeof window !== 'undefined') {
      window.dispatchEvent(new Event('resize'));
    }
  };
  const [columnSearch, setColumnSearch] = useState('');
  const [columnGroup, setColumnGroup] = useState<ColumnGroup>('Overview');
  const [savedColumnIds, setSavedColumnIds] = useLocalStorageState<string[]>('nexus-scanner.screener.columns.v1', DEFAULT_COLUMNS);
  const selectedColumnIds = Array.isArray(savedColumnIds) ? savedColumnIds : DEFAULT_COLUMNS;
  const phone = usePhoneLayout();
  const hasTradingView = Boolean(data?.rows.some(row => row.tradingview));
  const hasFnoBan = Boolean(data?.rows.some(row => row.fnoBan != null));
  const activeColumns = columns.filter(column => {
    if (column.id === 'company') return true;
    if (column.id.startsWith('tv.') && !hasTradingView) return false;
    if (column.id === 'fnoBan' && !hasFnoBan) return false;
    return selectedColumnIds.includes(column.id);
  });
  const usingCustomColumns = selectedColumnIds.length !== DEFAULT_COLUMNS.length || DEFAULT_COLUMNS.some(id => !selectedColumnIds.includes(id));
  const layout = tableLayout(activeColumns, 'screener', phone, usingCustomColumns);
  const visibleColumns = layout.columns;
  const customizableColumns = columns.filter(column => column.id !== 'company'
    && (!column.id.startsWith('tv.') || hasTradingView)
    && (column.id !== 'fnoBan' || hasFnoBan));
  const matchingColumns = customizableColumns.filter(column => `${column.label} ${column.group}`.toLowerCase().includes(columnSearch.trim().toLowerCase()));
  const pickerColumns = columnSearch.trim() ? matchingColumns : customizableColumns.filter(column => column.group === columnGroup);
  const scrollRef = useRef<HTMLDivElement>(null);
  const overview = useSymbolHoverCard<ScreenerRunResponse['rows'][number]>();
  const resetScroll = () => { overview.dismiss(); if (scrollRef.current) scrollRef.current.scrollTop = 0; };
  const rows = data?.rows ?? [];
  const busy = isLoading || isFetching;
  return <section className="results-surface" aria-label="Screener results">
    <div className="results-toolbar">
      <div className="result-count"><strong>{data?.matchCount.toLocaleString('en-IN') ?? '-'}</strong><span>matched equities <span className="result-universe">/ {data?.totalUniverseCount.toLocaleString('en-IN') ?? '-'} universe</span></span></div>
      {onSymbolSearchChange && <label className="results-symbol-search"><Search size={13} aria-hidden="true" /><input type="search" aria-label="Search symbol or company" placeholder="Search symbol" value={symbolSearch} onChange={event => {resetScroll(); onSymbolSearchChange(event.target.value);}} /></label>}
      <div className="results-actions">
        {(isError || busy) && <span role="status" className="fetch-status">{isError ? 'Query failed' : 'Updating results'}</span>}
        <div className="results-view-toggle" role="group" aria-label="Result view">
          <button type="button" aria-pressed={resultView === 'table'} onClick={() => handleResultViewChange('table')}><Table2 size={14}/><span>List</span></button>
          <button type="button" aria-pressed={resultView === 'charts'} onClick={() => handleResultViewChange('charts')}><ChartNoAxesCombined size={14}/><span>Charts</span></button>
        </div>
        <CopyResults symbols={data?.matchedSymbols?.length === data?.matchCount ? data?.matchedSymbols : undefined}
          loadRows={loadExportRows ?? (async()=>{
            if (rows.length !== data?.matchCount) throw new Error('All matching symbols are unavailable. Run the scan again.');
            return rows;
          })} revision={data?.immutableRevision} disabled={!rows.length || busy || isError}/>
        <DownloadResults
          loadRows={loadExportRows ?? (async () => rows)}
          columns={visibleColumns}
          filename={`nexus-results-${data?.resolvedSession?.date ?? 'export'}.csv`}
          disabled={!rows.length || busy || isError}
        />
        <button type="button" className="button button-secondary" aria-label="Customize columns" title="Customize columns" onClick={() => setColumnPickerOpen(true)}><SlidersHorizontal size={14} /><span>Columns</span></button>
      </div>
    </div>
    {columnPickerOpen && <Dialog label="Customize columns" className="column-dialog" onClose={() => setColumnPickerOpen(false)}>
      <div className="dialog-header"><div><h2>Customize columns</h2><p>{visibleColumns.length - 1} selected · choose fields for your results table</p></div><button type="button" className="icon-button" aria-label="Close column customization" onClick={() => setColumnPickerOpen(false)}><X size={18} /></button></div>
      <div className="column-dialog-content">
        <label className="column-search"><Search size={14} /><input type="search" aria-label="Search columns" placeholder="Search columns" value={columnSearch} onChange={event => setColumnSearch(event.target.value)} /></label>
        <div className="column-dialog-toolbar"><span>{columnSearch.trim() ? `${pickerColumns.length} results` : `${pickerColumns.filter(column => selectedColumnIds.includes(column.id)).length} selected in ${columnGroup.toLowerCase()}`}</span><div>
          <button type="button" className="button button-ghost" onClick={() => { resetScroll(); setSavedColumnIds(customizableColumns.map(column => column.id)); }}>Select all</button>
          <button type="button" className="button button-ghost" onClick={() => { resetScroll(); setSavedColumnIds(DEFAULT_COLUMNS); }}>Reset</button>
        </div></div>
        {!columnSearch.trim() && <div className="column-category-tabs" role="tablist" aria-label="Column categories">
          {COLUMN_GROUPS.map(group => {
            const count = customizableColumns.filter(column => column.group === group && selectedColumnIds.includes(column.id)).length;
            return (
              <button
                key={group}
                type="button"
                role="tab"
                aria-selected={columnGroup === group}
                aria-label={group}
                onClick={() => setColumnGroup(group)}
                className="column-category-btn"
              >
                <span>{group}</span>
                {count > 0 && <span className="column-category-badge" aria-hidden="true">{count}</span>}
              </button>
            );
          })}
        </div>}
        <div className="column-options" role="group" aria-label={columnSearch.trim() ? 'Search results' : `${columnGroup} columns`}>
          {pickerColumns.length ? pickerColumns.map(column => <label key={column.id} className="column-picker-option">
            <input type="checkbox" aria-label={column.label} checked={selectedColumnIds.includes(column.id)}
              onChange={event => { resetScroll(); setSavedColumnIds(current => event.target.checked
                ? [...new Set([...(Array.isArray(current) ? current : DEFAULT_COLUMNS), column.id])]
                : (Array.isArray(current) ? current : DEFAULT_COLUMNS).filter(id => id !== column.id)); }} />
            <span>{column.label}</span>{columnSearch.trim() && <small>{column.group}</small>}
          </label>) : <p className="column-search-empty">No matching columns.</p>}
        </div>
      </div>
    </Dialog>}
    {!isError && data?.warnings?.map(warning => <p key={warning} role="status" className="notice">{warning}</p>)}
    {chartsMounted && !isError && (
      <div style={{ display: resultView === 'charts' ? 'contents' : 'none' }}>
        <QuickChartsView
          rows={rows}
          revision={data?.immutableRevision}
          matchCount={data?.matchCount}
          matchedSymbols={data?.matchedSymbols}
          loadRows={loadExportRows}
          busy={busy}
          firstRank={((data?.page ?? 1) - 1) * (data?.pageSize ?? rows.length) + 1}
          onOpenFullChart={onOpenFullChart}
        />
      </div>
    )}
    <div style={{ display: resultView === 'table' ? 'contents' : 'none' }}>
      <div className="table-viewport" aria-busy={busy}>
        <div ref={scrollRef} className="table-scroll" tabIndex={0} aria-label="Equity results table, scroll for more columns">
          <table className="data-table" aria-rowcount={rows.length + 1} aria-colcount={visibleColumns.length} style={layout.style}>
            <caption className="sr-only">Equities matching the current screen</caption>
            <colgroup>{visibleColumns.map(column => <col key={column.id} style={{width: layout.columnWidth(column)}} />)}</colgroup>
            <thead><tr>{visibleColumns.map((column, index) => <th key={column.id} title={column.label} data-column={column.id} scope="col" aria-colindex={index + 1}
              aria-sort={column.sortField ? currentSort?.field === column.sortField ? currentSort.direction === 'asc' ? 'ascending' : 'descending' : 'none' : undefined}>
              {column.sortField ? <button type="button" disabled={busy} onClick={() => {resetScroll(); onSortChange(column.sortField!, currentSort?.field === column.sortField && currentSort?.direction === 'asc' ? 'desc' : 'asc');}}>
                {column.label}{currentSort?.field === column.sortField ? currentSort?.direction === 'asc' ? <ArrowUp size={13} /> : <ArrowDown size={13} /> : <ArrowUpDown size={13} />}
              </button> : column.label}
            </th>)}</tr></thead>
            <tbody>
              {isError ? <tr><td colSpan={visibleColumns.length}><div className="data-state" role="alert"><AlertTriangle size={28} /><h2>Screener query failed</h2><p>{error?.message || 'The query could not be completed.'}</p>{onRetry && <button className="button button-secondary" onClick={onRetry}>Retry</button>}</div></td></tr>
                : !data ? Array.from({length: 10}, (_, i) => <tr key={i} className="skeleton-row">{visibleColumns.map(column => <td key={column.id}><span className="skeleton" /></td>)}</tr>)
                : !rows.length ? <tr><td colSpan={visibleColumns.length}><div className="data-state"><SearchX size={28} /><h2>No equities matched</h2><p>Adjust your filters or choose a broader universe.</p></div></td></tr>
                : rows.map((row, index) => <tr key={index} aria-rowindex={index + 2}>{visibleColumns.map((column, columnIndex) => <td key={column.id} aria-colindex={columnIndex + 1} className={column.id === 'company' ? '' : 'numeric'}>
                  {column.id === 'company' ? <div className="company-cell"><button type="button" className="ipo-company-trigger" aria-label={`View ${row.symbol} company snapshot`}
                    aria-haspopup="dialog" aria-expanded={overview.active?.row.symbol === row.symbol}
                    onMouseEnter={event => { if (!phone) overview.open(row, event.currentTarget); }}
                    onMouseLeave={() => { if (!phone) overview.scheduleClose(); }}
                    onFocus={event => { if (!phone) overview.open(row, event.currentTarget); }}
                    onKeyDown={event => {
                      if (['ArrowDown', 'Enter', ' '].includes(event.key)) {
                        event.preventDefault(); overview.enter(row, event.currentTarget);
                      }
                    }}
                    onBlur={event => {if (!phone && !document.getElementById(`company-overview-${row.symbol}`)?.contains(event.relatedTarget)) overview.scheduleClose();}}
                    onClick={event => overview.active?.row.symbol === row.symbol && overview.active.pinned
                      ? overview.dismiss() : overview.open(row, event.currentTarget, true)}>
                      <SymbolWithLogo symbol={row.symbol} name={row.name} badge={row.isFno && <span className="fno-label">F&amp;O</span>} /></button>
                    <div className="company-tools"><button type="button" className="icon-button filing-button" aria-label={`View ${row.symbol} announcements`} title="View announcements" onClick={() => setFilingSymbol(row.symbol)} disabled={busy}><FileText size={14} strokeWidth={1.8} /></button></div></div>
                    : column.id === 'sector' ? <><div className={row.sector === 'Unclassified' ? 'cell-muted truncate' : 'cell-label truncate'} title={row.sector}>{row.sector}</div><div className="cell-secondary truncate" title={row.industry}>{row.industry}</div></>
                    : column.id === 'deliveryPct' && row.deliveryPct == null ? <span className="cell-muted">Unavailable</span>
                    : column.id === 'changePct' && row.changePct != null ? <span className={row.changePct >= 0 ? 'positive' : 'negative'}>{row.changePct >= 0 ? '+' : ''}{displayValue(column.getValue(row), column.format)}</span>
                    : column.id === 'rvol' && row.rvol != null ? <span className={row.rvol >= 2 ? 'volume-badge' : ''}>{displayValue(column.getValue(row), column.format)}</span>
                    : displayValue(column.getValue(row), column.format)}
                </td>)}</tr>)}
            </tbody>
          </table>
        </div>
      </div>
      <Pagination page={data?.page ?? page ?? 1} pageSize={pageSize ?? data?.pageSize ?? 15} total={data?.matchCount} busy={busy || isError || !data} onPageChange={page => {resetScroll(); onPageChange(page);}} onPageSizeChange={onPageSizeChange && (size => {resetScroll(); onPageSizeChange(size);})} />
    </div>
    {overview.active && overview.id && !busy && !isError && !columnPickerOpen && !filingSymbol && rows.some(row => row.symbol === overview.active!.row.symbol) &&
      <TijoriDetailsCard key={overview.active.row.symbol} {...overview.active} id={overview.id}
        onClose={overview.close} onMouseEnter={overview.cancelClose} onMouseLeave={overview.scheduleClose} />}
    {filingSymbol && data && <AnnouncementsPanel key={`${filingSymbol}:${data.immutableRevision}`} symbol={filingSymbol} revision={data.immutableRevision} onClose={() => setFilingSymbol(null)} />}
  </section>;
}
