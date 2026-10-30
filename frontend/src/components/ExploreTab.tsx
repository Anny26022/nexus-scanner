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
import { isAvailableCondition } from '../utils/filterAvailability';
import { PRESET_CATALOG, rankedMetric, recipeMetrics } from '../data/presetCatalog';
import { explainCondition, explainExpressionTree } from '../utils/nqlParser';
import { ResultsTable } from './ResultsTable';
import { ScreenerModal } from './ScreenerModal';
import { useFilterChoices } from '../hooks/useFilterChoices';
import { SlidersHorizontal, X, RotateCcw, Play, ChevronDown, Search, Info, Sparkles, BarChart3 } from 'lucide-react';
import { useLocalStorageState, useSavedPagination } from '../hooks/useLocalStorageState';
import type { AnnouncementFilter } from '../api/announcements';
import { pagePlaceholder } from '../utils/pagePlaceholder';
import { useNextScreenPage, screenPageStaleTime } from '../hooks/useNextScreenPage';
import { hasUnavailableConditions, UnavailableConditions, UNAVAILABLE_CONDITIONS_MESSAGE } from './UnavailableConditions';
import { AiScreenerModal } from './AiScreenerModal';
import { ScanHistoryPanel } from './ScanHistoryPanel';
import { Button } from './Button';
import { SavedScreensMenu } from './SavedScreensMenu';
import type { ScreenDefinition } from '../utils/savedScreens';


interface ExploreTabProps {
  onUniverseChange?: (universe: UniverseType) => void;
  selectedAsOfDate: string;
  datasetRevision?: string;
  onRefreshRevision: () => Promise<string | undefined>;
  availableSessions?: Array<{ date: string; label: string; isHistorical: boolean; revision: string }>;
  onSelectSession?: (date: string) => void;
  onOpenFullChart?: (symbol: string, revision?: string, sessionDate?: string) => void;
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

export const ExploreTab: React.FC<ExploreTabProps> = ({
  selectedAsOfDate,
  onUniverseChange,
  datasetRevision,
  onRefreshRevision,
  availableSessions = [],
  onSelectSession,
  onOpenFullChart,
}) => {
  const [universe, setUniverse] = useLocalStorageState<UniverseType>('nexus-scanner.screener.universe.v1', 'mainboard');
  const etf = universe === 'etf';
  const [resultView, setResultView] = useLocalStorageState<'table' | 'charts'>('nexus-scanner.screener.result-view.v1', 'table');
  const asOfDate = selectedAsOfDate;
  const [matchMode, setMatchMode] = useLocalStorageState<MatchMode>('nexus-scanner.screener.match-mode.v1', 'all');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isScanHistoryOpen, setIsScanHistoryOpen] = useState(false);
  const [aiDraft, setAiDraft] = useState<{conditions: Record<string, ActiveCondition>; matchMode: MatchMode} | null>(null);
  const [isAiModalOpen, setIsAiModalOpen] = useState(false);
  const filterChoices = useFilterChoices(isModalOpen, datasetRevision, asOfDate, etf);
  const [activeQuery, setActiveQuery] = useLocalStorageState('nexus-scanner.screener.query.v1', '');
  const [queryText, setQueryText] = useState(activeQuery);
  const [activeConditionsMap, setActiveConditionsMap] =
    useLocalStorageState<Record<string, ActiveCondition>>('nexus-scanner.screener.conditions.v1', DEFAULT_CONDITIONS);
  const {page, pageSize, setPage, setPageSize} = useSavedPagination('nexus-scanner.screener.pagination.v1', datasetRevision, 15);
  const [symbolSearch, setSymbolSearch] = useState('');
  const [announcementFilter, setAnnouncementFilter] = useState<AnnouncementFilter>();
  const [sort, setSort] = useLocalStorageState<{ field: string; direction: 'asc' | 'desc' }>('nexus-scanner.screener.sort.v1', {
    field: 'rvol',
    direction: 'desc',
  });

  const hasUnavailable = hasUnavailableConditions(activeConditionsMap);

  const expressionTree: ExpressionNode = useMemo(
    () => ({
      type: 'group',
      operator: matchMode,
      children: Object.values(activeConditionsMap).map((c) => ({ type: 'condition', condition: c })),
    }),
    [matchMode, activeConditionsMap]
  );

  const explanationResult = useMemo(
    () => explainExpressionTree(expressionTree, asOfDate),
    [expressionTree, asOfDate]
  );

  const runRequest: ScreenerRunRequest = useMemo(
    () => ({
      expressionTree,
      announcementFilter,
      textQuery: activeQuery || undefined,
      symbolSearch: symbolSearch.trim() || undefined,
      universe,
      asOfDate,
      datasetRevision,
      sort,
      page,
      pageSize,
    }),
    [expressionTree, activeQuery, symbolSearch, universe, asOfDate, datasetRevision, sort, page, pageSize, announcementFilter]
  );

  const { data, isLoading, isFetching, isError, error, refetch } = useQuery({
    queryKey: ['screenRun', runRequest],
    queryFn: () => {
      if (hasUnavailable) throw new Error(UNAVAILABLE_CONDITIONS_MESSAGE);
      return screenerApi.runScreen(runRequest);
    },
    enabled: Boolean(asOfDate) && !hasUnavailable,
    staleTime: screenPageStaleTime(runRequest),
    placeholderData: (previous, query) => pagePlaceholder(previous, query?.queryKey[1], runRequest),
  });

  useNextScreenPage('screenRun', runRequest, data, !hasUnavailable && !isFetching && !isError);

  // Library scans built on published performance show that performance as a column.
  const scanColumns = useMemo(() => [...new Set(Object.values(activeConditionsMap)
    .flatMap(condition => recipeMetrics(condition.conditionId)).map(metric => `tv.${metric}`))], [activeConditionsMap]);
  const handleApply = (newMap: Record<string, ActiveCondition>, newMatchMode: MatchMode) => {
    // A newly added ranked scan reads as a leaderboard: order by the metric it ranks on.
    const before = new Set(Object.values(activeConditionsMap).map(condition => condition.conditionId));
    const ranked = Object.values(newMap).map(condition => !before.has(condition.conditionId) && rankedMetric(condition.conditionId)).find(Boolean);
    if (ranked) setSort({field: `tv.${ranked}`, direction: 'desc'});
    setAiDraft(null);
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
    setSymbolSearch('');
    setActiveConditionsMap({});
    setAnnouncementFilter(undefined);
    setActiveQuery('');
    setQueryText('');
    setPage(1);
  };

  const handleRun = async () => {
    if (hasUnavailable) return;
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

  const filterCount = Object.keys(activeConditionsMap).length;

  const currentScreen: ScreenDefinition = {universe, matchMode, conditions: activeConditionsMap, query: activeQuery, sort};
  const loadScreen = (screen: ScreenDefinition) => {
    setAiDraft(null);
    setUniverse(screen.universe);
    onUniverseChange?.(screen.universe);
    setMatchMode(screen.matchMode);
    setActiveConditionsMap(screen.conditions);
    setActiveQuery(screen.query);
    setQueryText(screen.query);
    setSort(screen.sort);
    setSymbolSearch('');
    setAnnouncementFilter(undefined);
    setPage(1);
  };

  const showBacktest = !etf && availableSessions.length > 0 && resultView !== 'charts';
  const openBacktest = () => {
    setIsScanHistoryOpen(true);
    requestAnimationFrame(() => document.getElementById('backtest-history')?.scrollIntoView({behavior: 'smooth', block: 'start'}));
  };

  return <div className="research-view">
    <section className="screen-controls" aria-label="Screen criteria">
      <div className="screen-toolbar">
        <div className="universe-control">
          <div className="universe-label-row">
            <span className="field-label sr-only">Universe</span>
            <button
              type="button"
              className="universe-info-button"
              data-tooltip={
                etf ? 'NSE ETF listings from the selected daily snapshot.' : universe === 'mainboard'
                  ? 'Mainboard: All active NSE mainboard listed equities (excludes SME, debt, and suspended listings).'
                  : universe === 'nifty50'
                  ? 'Nifty 50: The 50 largest, most liquid blue-chip equities representing the benchmark Indian index.'
                  : universe === 'nifty500'
                  ? 'Nifty 500: Top 500 companies by market capitalization and liquidity across NSE sectors.'
                  : 'MidSmall 400: Nifty Midcap 150 and Smallcap 250 universe combined (excludes Nifty 100 large caps).'
              }
              aria-label="Universe filter details"
            >
              <Info size={11} strokeWidth={2.2} />
            </button>
          </div>
          <span className="select-wrap">
            <select aria-label="Stock universe" value={universe} onChange={e => {
              const next = e.target.value as UniverseType;
              if ((next === 'etf') !== etf) {
                handleReset(); setAiDraft(null); setSort({field:'symbol', direction:'asc'}); setResultView('table');
              }
              setUniverse(next); onUniverseChange?.(next); setPage(1);
            }}>
              <option value="mainboard">Mainboard</option><option value="nifty50">Nifty 50</option><option value="nifty500">Nifty 500</option><option value="midsmall400">MidSmall 400</option><option value="etf">ETFs</option>
            </select><ChevronDown size={14} />
          </span>
        </div>
        <label className="query-control"><span className="field-label sr-only">Scanner query</span><span className="query-input"><Search size={16} />
          <input disabled={etf} aria-label="Scanner query" value={queryText} onChange={event => setQueryText(event.target.value)}
            onKeyDown={event => { if (event.key === 'Enter') void handleRun(); }} placeholder={etf ? "Select ETF criteria with Filters" : "e.g. P/E < 20 AND EPS > 10"} /></span></label>
        <div className="screen-buttons">
          {(filterCount > 0 || activeQuery || symbolSearch) && <Button variant="ghost" onClick={handleReset}><RotateCcw size={14} />Reset</Button>}
          {!etf && <Button
            variant="ghost"
            disabled
            title="Ask AI is turned off for now"
          >
            <Sparkles size={13} />
            <span>Ask AI</span>
          </Button>}
          <Button variant="ghost" onClick={() => setIsModalOpen(true)}><SlidersHorizontal size={15} />Filters{filterCount > 0 && <span className="count-badge">{filterCount}</span>}</Button>
          <Button variant="primary" onClick={() => void handleRun()} disabled={!asOfDate || isFetching || hasUnavailable}><Play size={14} />Run</Button>
          <SavedScreensMenu current={currentScreen} onLoad={loadScreen} />
          {showBacktest && <>
            <Button variant="ghost" className="toolbar-icon-button backtest-trigger" onClick={openBacktest} aria-expanded={isScanHistoryOpen} aria-label="Backtest" title={`Backtest this screen across ${availableSessions.length} sessions`}>
              <BarChart3 size={14} aria-hidden="true" />
            </Button>
          </>}
        </div>
      </div>
      {(activeQuery || filterCount > 0) && <div className="active-filters">
        {activeQuery ? <span className="filter-chip"><span className="truncate" title={activeQuery}>{activeQuery}</span><button onClick={() => {setActiveQuery(''); setQueryText(''); setPage(1);}} aria-label="Clear query"><X size={13} /></button></span>
          : Object.entries(activeConditionsMap).filter(([, cond]) => isAvailableCondition(cond)).map(([key, cond]) => {
            const def = NEXUS_CONDITION_CATALOG.find(c => c.id === cond.conditionId) || PRESET_CATALOG.find(c => c.id === cond.conditionId);
            const label = ['FUNDAMENTAL_METRIC', 'mom_return', 'PRICE_CHANGE_PCT'].includes(cond.conditionId)
              ? explainCondition(cond).explanation
              : ['SECTOR', 'INDUSTRY'].includes(cond.conditionId) && Array.isArray(cond.parameters.values) && cond.parameters.values.length
                ? `${def?.label ?? cond.conditionId}: ${cond.parameters.values.join(', ')}`
                : def?.label ?? cond.conditionId;
            return <span key={key} className="filter-chip">{label}<button aria-label={`Remove ${label}`} onClick={() => handleRemove(key)}><X size={13} /></button></span>;
          })}
      </div>}
      <UnavailableConditions conditions={activeConditionsMap} onRemove={handleRemove} />
      {!hasUnavailable && !activeQuery && explanationResult.compiledExplanations.length > 0 && <p className="criteria-summary">{explanationResult.compiledExplanations.map(e => e.humanReadableText).join(matchMode === 'all' ? '; ' : ' OR ')}</p>}
    </section>
    {!hasUnavailable && <ResultsTable key={etf ? "etf" : "stocks"} etf={etf} data={data} isLoading={isLoading || !asOfDate} isFetching={isFetching} isError={isError} error={error}
      loadExportRows={()=>screenerApi.getExportRows({...runRequest,datasetRevision:data?.immutableRevision ?? datasetRevision})}
      page={page} pageSize={pageSize}
      symbolSearch={symbolSearch} onSymbolSearchChange={value => {setSymbolSearch(value); setPage(1);}}
      onRetry={() => void refetch()} onPageChange={setPage} onPageSizeChange={setPageSize} onSortChange={(field, direction) => {setSort({field, direction}); setPage(1);}} currentSort={sort} pinnedColumns={scanColumns} onOpenFullChart={onOpenFullChart}
      resultView={resultView} onResultViewChange={setResultView} />}
    {showBacktest && isScanHistoryOpen && (
      <div id="backtest-history" className="backtest-section">
        <ScanHistoryPanel
          expressionTree={expressionTree}
          universe={universe}
          customSymbols={runRequest.customSymbols}
          availableSessions={availableSessions}
          currentSessionDate={asOfDate}
          onSelectSession={(date) => {
            onSelectSession?.(date);
          }}
          onClose={() => setIsScanHistoryOpen(false)}
        />
      </div>
    )}
    <ScreenerModal etf={etf} key={isModalOpen ? 'open' : 'closed'} isOpen={isModalOpen} onClose={() => {setIsModalOpen(false); setAiDraft(null);}} activeConditionsMap={aiDraft?.conditions ?? activeConditionsMap} matchMode={aiDraft?.matchMode ?? matchMode} onApply={handleApply} choices={filterChoices.data} choicesLoading={filterChoices.isPending} choicesError={filterChoices.isError} retryChoices={() => void filterChoices.refetch()} />
    {isAiModalOpen && <AiScreenerModal
      datasetRevision={datasetRevision}
      isOpen={isAiModalOpen}
      onClose={() => setIsAiModalOpen(false)}
      onApplyConditions={async (compiledConditions, _immediateRun, compiledMatchMode) => {
        await onRefreshRevision();
        handleApply(compiledConditions, compiledMatchMode);
      }}
      onOpenFilterEditor={(compiledConditions, compiledMatchMode) => {
        setAiDraft({conditions:compiledConditions, matchMode:compiledMatchMode});
        setIsModalOpen(true);
      }}
    />}
  </div>;
};
