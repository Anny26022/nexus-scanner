import React, { useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { screenerApi } from '../api/screenerApi';
import { ArrowUpDown, Calendar, Play, SlidersHorizontal, X, ChevronDown, Search, SearchX } from 'lucide-react';
import { ActiveCondition, ExpressionNode, MatchMode, ScreenerRunRequest } from '../types/screener';
import { NEXUS_CONDITION_CATALOG } from '../data/conditionCatalog';
import { PRESET_CATALOG } from '../data/presetCatalog';
import { ResultsTable } from './ResultsTable';
import { ScreenerModal } from './ScreenerModal';
import { useLocalStorageState } from '../hooks/useLocalStorageState';
import { SymbolWithLogo } from './SymbolWithLogo';
import { Pagination } from './Pagination';
import { pagePlaceholder } from '../utils/pagePlaceholder';

export const NewListingsTab: React.FC<{ datasetRevision?: string; selectedAsOfDate: string }> = ({ datasetRevision, selectedAsOfDate }) => {
  const [periodFilter, setPeriodFilter] = useLocalStorageState<'30d' | '90d' | '6m' | '1y' | 'all'>('nexus-scanner.ipo.period.v1', '1y');
  const [search, setSearch] = useLocalStorageState('nexus-scanner.ipo.search.v1', '');
  const [sort, setSort] = useLocalStorageState<{ field: 'listingDate' | 'currentPrice' | 'turnoverCrore' | 'marketCapCrore' | 'deliveryPct'; direction: 'asc' | 'desc' }>('nexus-scanner.ipo.sort.v1', { field: 'listingDate', direction: 'desc' });
  const [page, setPage] = useState(1);
  const [isFilterModalOpen, setIsFilterModalOpen] = useState(false);
  const [showScreenResults, setShowScreenResults] = useState(false);
  const [matchMode, setMatchMode] = useLocalStorageState<MatchMode>('nexus-scanner.ipo.match-mode.v1', 'all');
  const [conditions, setConditions] = useLocalStorageState<Record<string, ActiveCondition>>('nexus-scanner.ipo.conditions.v1', {});
  const [screenPage, setScreenPage] = useState(1);
  const [screenSort, setScreenSort] = useState<{ field: string; direction: 'asc' | 'desc' }>({ field: 'rvol', direction: 'desc' });
  const pageSize = 50;
  const scrollRef = useRef<HTMLDivElement>(null);

  const ipoQuery = useQuery({
    queryKey: ['ipos', datasetRevision],
    queryFn: () => screenerApi.getIpoCatalogue(),
    enabled: Boolean(datasetRevision),
  });
  const { isLoading } = ipoQuery;
  const ipoData = ipoQuery.data?.records ?? [];
  const providerStatus = ipoQuery.data?.providerStatus;

  const filteredIpos = useMemo(() => {
    const query = search.trim().toLowerCase();
    const periodDays = { '30d': 30, '90d': 90, '6m': 183, '1y': 365 } as const;
    const cutoff = new Date();
    if (periodFilter !== 'all') cutoff.setDate(cutoff.getDate() - periodDays[periodFilter]);
    return ipoData.filter(row => {
      const listingDate = new Date(`${row.listingDate}T00:00:00`);
      const inPeriod = periodFilter === 'all' || (!Number.isNaN(listingDate.getTime()) && listingDate >= cutoff);
      return inPeriod && (!query || `${row.symbol} ${row.name}`.toLowerCase().includes(query));
    }).sort((left, right) => {
      const a = sort.field === 'listingDate' ? left.listingDate : left[sort.field] ?? Number.NEGATIVE_INFINITY;
      const b = sort.field === 'listingDate' ? right.listingDate : right[sort.field] ?? Number.NEGATIVE_INFINITY;
      const order = a < b ? -1 : a > b ? 1 : 0;
      return sort.direction === 'asc' ? order : -order;
    });
  }, [ipoData, periodFilter, search, sort]);
  const pageCount = Math.max(1, Math.ceil(filteredIpos.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const visibleIpos = filteredIpos.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const updatePeriod = (value: typeof periodFilter) => {
    setPeriodFilter(value);
    setPage(1);
  };
  const updateSort = (field: typeof sort.field) => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    setSort(current => ({ field, direction: current.field === field && current.direction === 'desc' ? 'asc' : 'desc' }));
    setPage(1);
  };
  const expressionTree: ExpressionNode = useMemo(() => ({
    type: 'group', operator: matchMode,
    children: Object.values(conditions).map(condition => ({ type: 'condition', condition })),
  }), [conditions, matchMode]);
  const listingSymbols = useMemo(() => filteredIpos.map(row => row.symbol), [filteredIpos]);
  const screenRequest: ScreenerRunRequest = useMemo(() => ({
    datasetRevision, asOfDate: selectedAsOfDate, universe: 'custom', customSymbols: listingSymbols,
    expressionTree, sort: screenSort, page: screenPage, pageSize: 15,
  }), [datasetRevision, selectedAsOfDate, listingSymbols, expressionTree, screenSort, screenPage]);
  const screenQuery = useQuery({
    queryKey: ['ipoScreen', screenRequest],
    queryFn: () => screenerApi.runScreen(screenRequest),
    enabled: showScreenResults && Boolean(selectedAsOfDate) && listingSymbols.length > 0,
    placeholderData: (previous, query) => pagePlaceholder(previous, query?.queryKey[1], screenRequest),
  });
  const applyFilters = (next: Record<string, ActiveCondition>, mode: MatchMode) => {
    setConditions(next);
    setMatchMode(mode);
    setScreenPage(1);
    setShowScreenResults(true);
  };
  const activeConditions = Object.values(conditions);
  const removeCondition = (id: string) => {
    setConditions(current => {
      const next = { ...current };
      delete next[id];
      return next;
    });
    setScreenPage(1);
  };

  return <div className="research-view">
    <section className="screen-controls" aria-label="IPO criteria">
      <div className="screen-toolbar">
        <label className="universe-control"><span className="field-label">Listing period</span><span className="select-wrap"><select aria-label="Listing period" value={periodFilter} onChange={e => {updatePeriod(e.target.value as typeof periodFilter); setScreenPage(1);}}>
          <option value="30d">30 Days</option><option value="90d">90 Days</option><option value="6m">6 Months</option><option value="1y">1 Year</option><option value="all">All Time</option>
        </select><ChevronDown size={14} /></span></label>
        <label className="query-control"><span className="field-label">Find a listing</span><span className="query-input"><Search size={16} /><input aria-label="Search IPO listings" value={search} onChange={event => {setSearch(event.target.value); setPage(1); setScreenPage(1);}} placeholder="Search symbol or company" /></span></label>
        <div className="screen-buttons">
          {activeConditions.length > 0 && <button className="button button-ghost" onClick={() => {setConditions({}); setScreenPage(1);}}>Reset</button>}
          {showScreenResults && <button className="button button-secondary" onClick={() => setShowScreenResults(false)}>Listings</button>}
          <button className="button button-secondary" onClick={() => setIsFilterModalOpen(true)}><SlidersHorizontal size={15} />Filters{activeConditions.length > 0 && <span className="count-badge">{activeConditions.length}</span>}</button>
          <button className="button button-primary" onClick={() => {setScreenPage(1); setShowScreenResults(true);}} disabled={!filteredIpos.length || screenQuery.isFetching}><Play size={14} />Run</button>
        </div>
      </div>
      {activeConditions.length > 0 && <div className="active-filters">{activeConditions.map(condition => {
        const definition = NEXUS_CONDITION_CATALOG.find(item => item.id === condition.conditionId) ?? PRESET_CATALOG.find(item => item.id === condition.conditionId);
        return <span key={condition.instanceId} className="filter-chip">{definition?.label ?? condition.conditionId}<button aria-label={`Remove ${definition?.label ?? condition.conditionId}`} onClick={() => removeCondition(condition.conditionId)}><X size={13} /></button></span>;
      })}</div>}
    </section>
    {providerStatus && <p role="status" className="notice">
      IPO Decode: {providerStatus.state === 'complete' ? 'catalogue and analytics refreshed'
        : providerStatus.state === 'partial' ? 'refresh incomplete; some data may be older'
        : providerStatus.state === 'retained' ? 'refresh failed; retained data shown'
        : providerStatus.state === 'unavailable' ? 'refresh failed; provider data unavailable' : 'refresh completeness not recorded'}.
      {providerStatus.checkedAt && ` Checked ${new Date(providerStatus.checkedAt).toLocaleString('en-IN', {timeZone: 'Asia/Kolkata'})} IST.`}
    </p>}
    {showScreenResults && listingSymbols.length > 0 ? <ResultsTable data={screenQuery.data} isLoading={screenQuery.isLoading} isFetching={screenQuery.isFetching}
      isError={screenQuery.isError} error={screenQuery.error} onRetry={() => void screenQuery.refetch()} onPageChange={setScreenPage}
      onSortChange={(field, direction) => {setScreenSort({field, direction}); setScreenPage(1);}} currentSort={screenSort} />
      : <section className="results-surface" aria-label="IPO listings">
        <div className="results-toolbar"><div className="result-count"><strong>{!isLoading && (!ipoQuery.isError || ipoQuery.data) ? filteredIpos.length.toLocaleString('en-IN') : '-'}</strong><span>new listings</span></div><span className="cell-muted text-xs">Published catalogue</span></div>
        <div className="table-viewport"><div ref={scrollRef} className="table-scroll" tabIndex={0} aria-label="IPO table, scroll for more columns">
          <table className="data-table ipo-table"><caption className="sr-only">Newly listed companies</caption>
            <colgroup>{['26%', '12%', '12%', '12%', '12%', '9%', '17%'].map((width, i) => <col key={i} style={{width}} />)}</colgroup>
            <thead><tr><th scope="col">Company</th>{([['listingDate', 'Listing date'], ['currentPrice', 'Current price'], ['turnoverCrore', 'Daily turnover'], ['marketCapCrore', 'Market cap'], ['deliveryPct', 'Delivery']] as const).map(([field, label]) =>
              <th scope="col" key={field} aria-sort={sort.field === field ? sort.direction === 'asc' ? 'ascending' : 'descending' : 'none'}><button onClick={() => updateSort(field)}>{label}<ArrowUpDown size={13} /></button></th>)}<th scope="col">Sector / industry</th></tr></thead>
            <tbody>{isLoading ? Array.from({length: 10}, (_, i) => <tr key={i} className="skeleton-row">{Array.from({length: 7}, (_, j) => <td key={j}><span className="skeleton" /></td>)}</tr>)
              : ipoQuery.isError && !ipoQuery.data ? <tr><td colSpan={7}><div role="alert" className="data-state"><h2>IPO catalogue could not be loaded.</h2><button className="button button-secondary" onClick={() => void ipoQuery.refetch()}>Retry</button></div></td></tr>
              : !filteredIpos.length ? <tr><td colSpan={7}><div className="data-state"><SearchX size={28} /><h2>No new listings recorded for selected period window.</h2><p>Choose a longer period or clear your search.</p></div></td></tr>
              : visibleIpos.map(row => <tr key={row.symbol}>
                <td><SymbolWithLogo symbol={row.symbol} name={row.name} />
                  {row.ipoDetailStatus && <details className="ipo-refresh-detail"><summary>IPO Decode details</summary><p>{row.ipoDetailStatus.lastSuccessAt ? `Last complete refresh ${new Date(row.ipoDetailStatus.lastSuccessAt).toLocaleString('en-IN', {timeZone: 'Asia/Kolkata'})} IST` : 'No complete refresh recorded'}</p>
                    {row.ipoDetailStatus.failedEndpoints.length > 0 && <p>Refresh failed: {row.ipoDetailStatus.failedEndpoints.join(', ')}. Available data retained.</p>}</details>}
                </td>
                <td className="numeric"><span className="inline-flex items-center gap-1.5"><Calendar size={12} />{row.listingDate}</span></td>
                <td className="numeric cell-strong">₹{row.currentPrice.toLocaleString('en-IN', {minimumFractionDigits: 2})}</td>
                <td className="numeric">₹{row.turnoverCrore.toLocaleString('en-IN')} Cr</td>
                <td className="numeric">₹{row.marketCapCrore.toLocaleString('en-IN')} Cr</td>
                <td className="numeric">{row.deliveryPct == null ? 'N/A' : `${row.deliveryPct.toFixed(1)}%`}</td>
                <td><div className="cell-label truncate" title={row.sector}>{row.sector}</div><div className="cell-secondary truncate" title={row.industry}>{row.industry}</div></td>
              </tr>)}
            </tbody>
          </table>
        </div>
        <Pagination page={currentPage} pageSize={pageSize} total={filteredIpos.length} busy={isLoading || (ipoQuery.isError && !ipoQuery.data)} onPageChange={page => {if (scrollRef.current) scrollRef.current.scrollTop = 0; setPage(page);}} />
        </div>
      </section>}
    <ScreenerModal key={isFilterModalOpen ? 'open' : 'closed'} isOpen={isFilterModalOpen} onClose={() => setIsFilterModalOpen(false)} activeConditionsMap={conditions} matchMode={matchMode} onApply={applyFilters} />
  </div>;
};
