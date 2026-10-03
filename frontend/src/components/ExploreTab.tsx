import React, { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  UniverseType,
  MatchMode,
  ActiveCondition,
  ExpressionNode,
  ScreenerRunRequest,
} from '../types/screener';
import { screenerApi } from '../api/screenerApi';
import { NEXUS_CONDITION_CATALOG } from '../data/conditionCatalog';
import { PRESET_CATALOG } from '../data/presetCatalog';
import { explainExpressionTree } from '../utils/nqlParser';
import { ResultsTable } from './ResultsTable';
import { ScreenerModal } from './ScreenerModal';
import { SlidersHorizontal, X, RotateCcw, Play, ChevronDown } from 'lucide-react';
import { useLocalStorageState } from '../hooks/useLocalStorageState';

interface ExploreTabProps {
  selectedAsOfDate: string;
  datasetRevision?: string;
  onRefreshRevision: () => Promise<string | undefined>;
  onAddToWatchlist?: (symbols: string[]) => void;
}

const DEFAULT_CONDITIONS: Record<string, ActiveCondition> = {
  mom_rvol: {
    instanceId: 'default_rvol',
    conditionId: 'mom_rvol',
    parameters: { minRvol: 1.5, maxRvol: 20.0 },
  },
  trend_price_vs_ma: {
    instanceId: 'default_sma50',
    conditionId: 'trend_price_vs_ma',
    parameters: { maType: 'SMA', maPeriod: 50, operator: 'above', thresholdPct: 0 },
  },
};

export const ExploreTab: React.FC<ExploreTabProps> = ({ selectedAsOfDate, datasetRevision, onRefreshRevision, onAddToWatchlist }) => {
  const [universe, setUniverse] = useLocalStorageState<UniverseType>('nexus-scanner.screener.universe.v1', 'mainboard');
  const asOfDate = selectedAsOfDate;
  const [matchMode, setMatchMode] = useLocalStorageState<MatchMode>('nexus-scanner.screener.match-mode.v1', 'all');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [activeQuery, setActiveQuery] = useLocalStorageState('nexus-scanner.screener.query.v1', '');
  const [queryText, setQueryText] = useState(activeQuery);
  const [activeConditionsMap, setActiveConditionsMap] =
    useLocalStorageState<Record<string, ActiveCondition>>('nexus-scanner.screener.conditions.v1', DEFAULT_CONDITIONS);
  const [page, setPage] = useState(1);
  const [sort, setSort] = useLocalStorageState<{ field: string; direction: 'asc' | 'desc' }>('nexus-scanner.screener.sort.v1', {
    field: 'rvol',
    direction: 'desc',
  });

  const activeConditionsArray = useMemo(() => Object.values(activeConditionsMap), [activeConditionsMap]);

  const expressionTree: ExpressionNode = useMemo(
    () => ({
      type: 'group',
      operator: matchMode,
      children: activeConditionsArray.map((c) => ({ type: 'condition', condition: c })),
    }),
    [matchMode, activeConditionsArray]
  );

  const explanationResult = useMemo(
    () => explainExpressionTree(expressionTree, asOfDate),
    [expressionTree, asOfDate]
  );

  const runRequest: ScreenerRunRequest = useMemo(
    () => ({
      expressionTree,
      textQuery: activeQuery || undefined,
      universe,
      asOfDate,
      datasetRevision,
      sort,
      page,
      pageSize: 15,
    }),
    [expressionTree, activeQuery, universe, asOfDate, datasetRevision, sort, page]
  );

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['screenRun', runRequest],
    queryFn: () => screenerApi.runScreen(runRequest),
    enabled: Boolean(asOfDate),
  });

  const handleApply = (newMap: Record<string, ActiveCondition>, newMatchMode: MatchMode) => {
    setActiveConditionsMap(newMap);
    setMatchMode(newMatchMode);
    setActiveQuery('');
    setQueryText('');
    setPage(1);
  };

  const handleRemove = (id: string) => {
    setActiveConditionsMap((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setPage(1);
  };

  const handleReset = () => {
    setActiveConditionsMap({});
    setActiveQuery('');
    setQueryText('');
    setPage(1);
  };

  const handleRun = async () => {
    const nextQuery = queryText.trim();
    // Refresh before changing query state.  Otherwise the render caused by a
    // new query can submit the revision captured before this button press.
    const refreshedRevision = await onRefreshRevision();
    if (nextQuery !== activeQuery) {
      setActiveQuery(nextQuery);
      setPage(1);
      return;
    }
    if (refreshedRevision === datasetRevision) await refetch();
  };

  const filterCount = activeConditionsArray.length;

  return (
    <div className="space-y-4">
      {/* ── Sleek Control Strip ── */}
      <div className="space-y-2">
        {/* Row 1: Controls */}
        <div className="flex items-center justify-between gap-3">

          {/* Left: Universe */}
          <div className="flex items-center gap-2">
            {/* Universe */}
            <div className="relative">
              <select
                value={universe}
                onChange={(e) => { setUniverse(e.target.value as UniverseType); setPage(1); }}
                className="appearance-none bg-white border border-slate-200 text-slate-700 text-[11px] font-medium rounded-md pl-2.5 pr-6 py-1 h-7 focus:outline-none focus:border-teal-400 cursor-pointer hover:border-slate-300 transition-colors"
              >
                <option value="mainboard">Mainboard</option>
                <option value="nifty50">Nifty 50</option>
                <option value="nifty500">Nifty 500</option>
                <option value="midsmall400">MidSmall 400</option>
              </select>
              <ChevronDown className="absolute right-1.5 top-1/2 -translate-y-1/2 w-3 h-3 text-slate-400 pointer-events-none" />
            </div>

          </div>

          <div className="ml-auto flex items-center gap-2">
            <input
              aria-label="Scanner query"
              value={queryText}
              onChange={(event) => setQueryText(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter') void handleRun(); }}
              placeholder="Query, e.g. P/E < 20 AND EPS > 10"
              className="w-40 sm:w-56 lg:w-72 h-7 rounded-md border border-slate-200 bg-white px-2.5 text-[11px] text-slate-700 placeholder:text-slate-400 focus:outline-none focus:border-teal-400"
            />
            {filterCount > 0 && (
              <button
                onClick={handleReset}
                className="flex items-center gap-1 text-[10px] text-slate-400 hover:text-slate-600 cursor-pointer"
              >
                <RotateCcw className="w-2.5 h-2.5" />
                Reset
              </button>
            )}

            <button
              onClick={() => setIsModalOpen(true)}
              className="group flex items-center gap-1 px-2 py-1 text-slate-500 hover:text-slate-700 text-[11px] font-medium transition-colors cursor-pointer"
            >
              <SlidersHorizontal className="w-3 h-3" />
              <span>Filters</span>
              {filterCount > 0 && (
                <span className="bg-teal-500 text-white text-[9px] font-bold rounded-full min-w-[14px] h-3.5 flex items-center justify-center leading-none px-0.5">
                  {filterCount}
                </span>
              )}
            </button>

            {/* Run */}
            <button
              onClick={() => void handleRun()}
              disabled={!asOfDate}
              className="flex items-center gap-1 px-2.5 py-1 bg-teal-600 hover:bg-teal-500 text-white text-[11px] font-medium rounded-md transition-all cursor-pointer disabled:opacity-40"
            >
              <Play className="w-2.5 h-2.5 fill-current" />
              Run
            </button>
          </div>
        </div>

        {/* Row 2: Active Filter Pills (only show when filters exist) */}
        {activeQuery && (
          <div className="flex items-center gap-1.5 text-[10px] text-slate-500 font-mono">
            <span className="text-teal-700 font-semibold">Query</span>
            <span className="truncate">{activeQuery}</span>
            <button onClick={() => { setActiveQuery(''); setQueryText(''); setPage(1); }}
              aria-label="Clear query" className="text-slate-400 hover:text-slate-700"><X className="w-2.5 h-2.5" /></button>
          </div>
        )}

        {!activeQuery && filterCount > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            {activeConditionsArray.map((cond) => {
              const def = NEXUS_CONDITION_CATALOG.find((c) => c.id === cond.conditionId) || 
                          PRESET_CATALOG.find((c) => c.id === cond.conditionId);
              return (
                <span
                  key={cond.conditionId}
                  className="inline-flex items-center gap-1 pl-2 pr-1 py-0.5 bg-slate-50 text-slate-600 border border-slate-200 rounded text-[10px] font-medium"
                >
                  {def?.label ?? cond.conditionId}
                  <button
                    onClick={() => handleRemove(cond.conditionId)}
                    className="text-slate-400 hover:text-slate-700 cursor-pointer p-0.5"
                  >
                    <X className="w-2.5 h-2.5" />
                  </button>
                </span>
              );
            })}
            <button
              onClick={() => setIsModalOpen(true)}
              className="text-[10px] text-slate-400 hover:text-teal-600 cursor-pointer font-medium"
            >
              + add
            </button>
          </div>
        )}

        {/* Row 3: Query summary (subtle mono readout) */}
        {!activeQuery && explanationResult.compiledExplanations.length > 0 && (
          <div className="text-[10px] text-slate-400 font-mono truncate px-0.5">
            {explanationResult.compiledExplanations
              .map((e) => e.humanReadableText)
              .join(matchMode === 'all' ? ' · ' : ' | ')}
          </div>
        )}
      </div>

      {/* ── Results Table ── */}
      <ResultsTable
        data={data}
        isLoading={isLoading}
        isError={isError}
        error={error}
        onPageChange={setPage}
        onSortChange={(field, direction) => setSort({ field, direction })}
        currentSort={sort}
        onAddToWatchlist={onAddToWatchlist}
      />

      {/* ── Screener Modal ── */}
      <ScreenerModal
        key={isModalOpen ? 'open' : 'closed'}
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        activeConditionsMap={activeConditionsMap}
        matchMode={matchMode}
        onApply={handleApply}
      />
    </div>
  );
};
