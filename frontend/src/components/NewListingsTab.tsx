import React, { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { screenerApi } from '../api/screenerApi';
import { ArrowUpDown, Calendar, Play, SlidersHorizontal, X } from 'lucide-react';
import { ActiveCondition, ExpressionNode, MatchMode, ScreenerRunRequest } from '../types/screener';
import { NEXUS_CONDITION_CATALOG } from '../data/conditionCatalog';
import { PRESET_CATALOG } from '../data/presetCatalog';
import { ResultsTable } from './ResultsTable';
import { baseStageForCondition } from '../engine/baseConditions';
import { ScreenerModal } from './ScreenerModal';
import { useLocalStorageState } from '../hooks/useLocalStorageState';
import { SymbolWithLogo } from './SymbolWithLogo';

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

  const { data: ipoData = [], isLoading } = useQuery({
    queryKey: ['ipos', datasetRevision],
    queryFn: () => screenerApi.getIpos(),
    enabled: Boolean(datasetRevision),
  });

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
  const visibleIpos = filteredIpos.slice((page - 1) * pageSize, page * pageSize);
  const updatePeriod = (value: typeof periodFilter) => {
    setPeriodFilter(value);
    setPage(1);
  };
  const updateSort = (field: typeof sort.field) => {
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

  return (
    <div className="space-y-4 animate-fade-in">
      <div className="rounded-2xl border border-gray-200 bg-white px-3 py-2.5 shadow-sm">
        <div className="flex flex-wrap items-center gap-2.5">
          <div className="flex shrink-0 items-center gap-2.5">
            <div className="relative">
            <select
              value={periodFilter}
              onChange={(e) => updatePeriod(e.target.value as typeof periodFilter)}
              className="appearance-none bg-gray-50 border border-gray-200 text-gray-800 text-xs font-semibold rounded-xl pl-3 pr-8 py-2 focus:outline-none focus:border-gray-400 cursor-pointer"
            >
              <option value="30d">30 Days</option>
              <option value="90d">90 Days</option>
              <option value="6m">6 Months</option>
              <option value="1y">1 Year</option>
              <option value="all">All Time</option>
            </select>
            <div className="absolute right-2.5 top-2.5 pointer-events-none">
              <svg className="w-3.5 h-3.5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7" /></svg>
            </div>
            </div>
            {activeConditions.length > 0 && <div className="h-4 w-px bg-gray-200" />}
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            {activeConditions.map(condition => {
              const definition = NEXUS_CONDITION_CATALOG.find(item => item.id === condition.conditionId) ?? PRESET_CATALOG.find(item => item.id === condition.conditionId);
              return <span key={condition.instanceId} className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-200 bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-800">{definition?.label ?? condition.conditionId}<button onClick={() => removeCondition(condition.conditionId)} className="text-emerald-600 hover:text-emerald-900"><X className="w-3 h-3" /></button></span>;
            })}
          </div>
          <div className="ml-auto flex items-center gap-2">
            <input value={search} onChange={event => { setSearch(event.target.value); setPage(1); }} placeholder="Search symbol or company" className="h-8 w-44 rounded-lg border border-slate-200 bg-white px-2.5 text-[11px] text-slate-700 outline-none placeholder:text-slate-400 focus:border-slate-400" />
            {!isLoading && <span className="whitespace-nowrap text-[11px] text-slate-400">{filteredIpos.length.toLocaleString('en-IN')} listings</span>}
            {activeConditions.length > 1 && <button onClick={() => { setConditions({}); setScreenPage(1); }} className="whitespace-nowrap text-xs text-gray-400 transition-colors hover:text-gray-600">Reset</button>}
            {showScreenResults && (
              <button type="button" onClick={() => setShowScreenResults(false)} className="px-3 py-2 text-xs font-semibold text-slate-500 transition-colors hover:text-slate-900">
                Listings
              </button>
            )}
            <button type="button" onClick={() => setIsFilterModalOpen(true)} className="group flex items-center gap-1 px-2 py-1 text-[11px] font-medium text-slate-500 transition-colors hover:text-slate-700">
              <SlidersHorizontal className="h-3 w-3" /> Filters
              {activeConditions.length > 0 && <span className="flex h-3.5 min-w-[14px] items-center justify-center rounded-full bg-teal-500 px-0.5 text-[9px] font-bold leading-none text-white">{activeConditions.length}</span>}
            </button>
            <button type="button" onClick={() => { setScreenPage(1); setShowScreenResults(true); }} disabled={filteredIpos.length === 0} className="flex items-center gap-1 rounded-md bg-teal-600 px-2.5 py-1 text-[11px] font-medium text-white transition-all hover:bg-teal-500 disabled:opacity-40">
              <Play className="h-2.5 w-2.5 fill-current" /> Run
            </button>
          </div>
        </div>
      </div>

      {showScreenResults ? (
        <ResultsTable
          data={screenQuery.data}
          isLoading={screenQuery.isLoading}
          isError={screenQuery.isError}
          error={screenQuery.error}
          onPageChange={setScreenPage}
          onSortChange={(field, direction) => { setScreenSort({ field, direction }); setScreenPage(1); }}
          baseStages={[...new Set(activeConditions.map(baseStageForCondition).filter(stage => stage !== undefined))]}
          currentSort={screenSort}
        />
      ) : (
        <>
      {/* IPO catalogue */}
      <div className="flex max-h-[calc(100svh-9rem)] min-h-[24rem] flex-col overflow-hidden rounded-2xl border border-slate-200/90 bg-white shadow-2xs">
        <div className="min-h-0 flex-1 overflow-auto">
          <table className="w-full text-left text-xs text-slate-800">
            <thead className="sticky top-0 z-10 bg-slate-50/95 text-slate-500 uppercase text-[10px] tracking-wider border-b border-slate-200/90 backdrop-blur-sm">
              <tr>
                <th className="py-3 px-4 font-semibold">Symbol & Company</th>
                {([
                  ['listingDate', 'Listing Date'], ['currentPrice', 'Current Price'], ['turnoverCrore', 'Daily Turnover'],
                  ['marketCapCrore', 'Market Cap'], ['deliveryPct', 'Delivery'],
                ] as const).map(([field, label]) => <th key={field} onClick={() => updateSort(field)} className="cursor-pointer py-3 px-4 font-semibold hover:text-slate-900"><span className="flex items-center gap-1">{label}<ArrowUpDown className="h-3 w-3" /></span></th>)}
                <th className="py-3 px-4 font-semibold">Sector / Industry</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 font-mono">
              {isLoading ? (
                <tr>
                  <td colSpan={7} className="py-10 text-center text-slate-500 font-sans">
                    <div className="inline-block animate-spin rounded-full h-5 w-5 border-2 border-slate-900 border-t-transparent mb-2"></div>
                    <p className="text-xs font-medium">Loading IPO catalogue...</p>
                  </td>
                </tr>
              ) : filteredIpos.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-10 text-center text-slate-400 font-sans">
                    No new listings recorded for selected period window.
                  </td>
                </tr>
              ) : (
                visibleIpos.map((row) => {
                  return (
                    <tr key={row.symbol} className="hover:bg-slate-50/70 transition-colors">
                      {/* Symbol & Name */}
                      <td className="py-3.5 px-4 font-sans">
                        <SymbolWithLogo symbol={row.symbol} name={row.name} />
                      </td>

                      {/* Listing Date */}
                      <td className="py-3.5 px-4 text-slate-700">
                        <div className="flex items-center space-x-1.5">
                          <Calendar className="h-3 w-3 text-slate-400" />
                          <span>{row.listingDate}</span>
                        </div>
                      </td>

                      {/* Current Price */}
                      <td className="py-3.5 px-4 font-semibold text-slate-900">
                        ₹{row.currentPrice.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                      </td>

                      {/* Turnover */}
                      <td className="py-3.5 px-4 text-slate-700">
                        ₹{row.turnoverCrore.toLocaleString('en-IN')} Cr
                      </td>

                      <td className="py-3.5 px-4 text-slate-700">₹{row.marketCapCrore.toLocaleString('en-IN')} Cr</td>

                      <td className="py-3.5 px-4 text-slate-700">{row.deliveryPct == null ? '—' : `${row.deliveryPct.toFixed(1)}%`}</td>

                      {/* Sector */}
                      <td className="py-3.5 px-4 font-sans text-xs">
                        <div className="text-slate-800 font-medium">{row.sector}</div>
                        <div className="text-[10px] text-slate-400">{row.industry}</div>
                      </td>


                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
        {!isLoading && filteredIpos.length > pageSize && (
          <div className="sticky bottom-0 z-20 flex shrink-0 items-center justify-between gap-3 border-t border-slate-200 bg-white/95 px-4 py-3 text-xs shadow-[0_-6px_16px_rgba(15,23,42,0.05)] backdrop-blur-sm">
            <span className="text-slate-500">{((page - 1) * pageSize + 1).toLocaleString('en-IN')}–{Math.min(page * pageSize, filteredIpos.length).toLocaleString('en-IN')} of {filteredIpos.length.toLocaleString('en-IN')}</span>
            <div className="flex gap-2">
              <button type="button" onClick={() => setPage(current => Math.max(1, current - 1))} disabled={page === 1} className="rounded-md border border-slate-200 px-2.5 py-1.5 font-medium text-slate-600 disabled:cursor-not-allowed disabled:opacity-40">Previous</button>
              <span className="px-1 py-1.5 text-slate-400">{page} / {pageCount}</span>
              <button type="button" onClick={() => setPage(current => Math.min(pageCount, current + 1))} disabled={page === pageCount} className="rounded-md border border-slate-200 px-2.5 py-1.5 font-medium text-slate-600 disabled:cursor-not-allowed disabled:opacity-40">Next</button>
            </div>
          </div>
        )}
      </div>
        </>
      )}
      <ScreenerModal
        isOpen={isFilterModalOpen}
        onClose={() => setIsFilterModalOpen(false)}
        activeConditionsMap={conditions}
        matchMode={matchMode}
        onApply={applyFilters}
      />
    </div>
  );
};
