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
import { PRESET_CATALOG } from '../data/presetCatalog';
import { explainCondition, explainExpressionTree } from '../utils/nqlParser';
import { ResultsTable } from './ResultsTable';
import { ScreenerModal } from './ScreenerModal';
import { useFilterChoices } from '../hooks/useFilterChoices';
import { SlidersHorizontal, X, RotateCcw, Play, ChevronDown, Search, Info } from 'lucide-react';
import { useLocalStorageState } from '../hooks/useLocalStorageState';
import type { AnnouncementFilter } from '../api/announcements';
import { pagePlaceholder } from '../utils/pagePlaceholder';
import { useNextScreenPage, screenPageStaleTime } from '../hooks/useNextScreenPage';
import { hasUnavailableConditions, UnavailableConditions, UNAVAILABLE_CONDITIONS_MESSAGE } from './UnavailableConditions';

interface ExploreTabProps {
  selectedAsOfDate: string;
  datasetRevision?: string;
  onRefreshRevision: () => Promise<string | undefined>;
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

export const ExploreTab: React.FC<ExploreTabProps> = ({ selectedAsOfDate, datasetRevision, onRefreshRevision }) => {
  const [universe, setUniverse] = useLocalStorageState<UniverseType>('nexus-scanner.screener.universe.v1', 'mainboard');
  const asOfDate = selectedAsOfDate;
  const [matchMode, setMatchMode] = useLocalStorageState<MatchMode>('nexus-scanner.screener.match-mode.v1', 'all');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const filterChoices = useFilterChoices(isModalOpen, datasetRevision);
  const [activeQuery, setActiveQuery] = useLocalStorageState('nexus-scanner.screener.query.v1', '');
  const [queryText, setQueryText] = useState(activeQuery);
  const [activeConditionsMap, setActiveConditionsMap] =
    useLocalStorageState<Record<string, ActiveCondition>>('nexus-scanner.screener.conditions.v1', DEFAULT_CONDITIONS);
  const [pagination, setPagination] = useState({revision: datasetRevision, page: 1});
  const [pageSize, setPageSize] = useState(15);
  const [symbolSearch, setSymbolSearch] = useState('');
  const page = pagination.revision === datasetRevision ? pagination.page : 1;
  const setPage = (next: number) => setPagination({revision: datasetRevision, page: next});
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

  return <div className="research-view">
    <section className="screen-controls" aria-label="Screen criteria">
      <div className="screen-toolbar">
        <div className="universe-control-group">
          <label className="universe-control"><span className="field-label">Universe</span><span className="select-wrap">
            <select aria-label="Stock universe" value={universe} onChange={e => {setUniverse(e.target.value as UniverseType); setPage(1);}}>
              <option value="mainboard">Mainboard</option><option value="nifty50">Nifty 50</option><option value="nifty500">Nifty 500</option><option value="midsmall400">MidSmall 400</option>
            </select><ChevronDown size={14} /></span></label>
          <button
            type="button"
            className="universe-info-button"
            data-tooltip={
              universe === 'mainboard'
                ? 'Mainboard universe: All active NSE mainboard listed equities (excludes SME, debt, and suspended listings).'
                : universe === 'nifty50'
                ? 'Nifty 50: The 50 largest, most liquid blue-chip equities representing the benchmark Indian index.'
                : universe === 'nifty500'
                ? 'Nifty 500: Top 500 companies by market capitalization and liquidity across NSE sectors.'
                : 'MidSmall 400: Nifty Midcap 150 and Smallcap 250 universe combined (excludes Nifty 100 large caps).'
            }
            aria-label="Universe filter details"
          >
            <Info size={14} strokeWidth={2} />
          </button>
        </div>
        <label className="query-control"><span className="field-label">Scanner query</span><span className="query-input"><Search size={16} />
          <input aria-label="Scanner query" value={queryText} onChange={event => setQueryText(event.target.value)}
            onKeyDown={event => { if (event.key === 'Enter') void handleRun(); }} placeholder="e.g. P/E < 20 AND EPS > 10" /></span></label>
        <div className="screen-buttons">
          {(filterCount > 0 || activeQuery || symbolSearch) && <button className="button button-ghost" onClick={handleReset}><RotateCcw size={14} />Reset</button>}
          <button onClick={() => setIsModalOpen(true)} className="button button-secondary"><SlidersHorizontal size={15} />Filters{filterCount > 0 && <span className="count-badge">{filterCount}</span>}</button>
          <button onClick={() => void handleRun()} disabled={!asOfDate || isFetching || hasUnavailable} className="button button-primary"><Play size={14} />Run</button>
        </div>
      </div>
      {(activeQuery || filterCount > 0) && <div className="active-filters">
        {activeQuery ? <span className="filter-chip"><span className="truncate" title={activeQuery}>{activeQuery}</span><button onClick={() => {setActiveQuery(''); setQueryText(''); setPage(1);}} aria-label="Clear query"><X size={13} /></button></span>
          : Object.entries(activeConditionsMap).filter(([, cond]) => isAvailableCondition(cond)).map(([key, cond]) => {
            const def = NEXUS_CONDITION_CATALOG.find(c => c.id === cond.conditionId) || PRESET_CATALOG.find(c => c.id === cond.conditionId);
            const label = ['FUNDAMENTAL_METRIC', 'mom_return', 'PRICE_CHANGE_PCT'].includes(cond.conditionId)
              ? explainCondition(cond).explanation : def?.label ?? cond.conditionId;
            return <span key={key} className="filter-chip">{label}<button aria-label={`Remove ${label}`} onClick={() => handleRemove(key)}><X size={13} /></button></span>;
          })}
      </div>}
      <UnavailableConditions conditions={activeConditionsMap} onRemove={handleRemove} />
      {!hasUnavailable && !activeQuery && explanationResult.compiledExplanations.length > 0 && <p className="criteria-summary">{explanationResult.compiledExplanations.map(e => e.humanReadableText).join(matchMode === 'all' ? '; ' : ' OR ')}</p>}
    </section>
    {!hasUnavailable && <ResultsTable data={data} isLoading={isLoading || !asOfDate} isFetching={isFetching} isError={isError} error={error}
      loadExportRows={()=>screenerApi.getExportRows({...runRequest,datasetRevision:data?.immutableRevision ?? datasetRevision})}
      symbolSearch={symbolSearch} onSymbolSearchChange={value => {setSymbolSearch(value); setPage(1);}}
      onRetry={() => void refetch()} onPageChange={setPage} onPageSizeChange={size => {setPageSize(size); setPage(1);}} onSortChange={(field, direction) => {setSort({field, direction}); setPage(1);}} currentSort={sort} />}
    <ScreenerModal key={isModalOpen ? 'open' : 'closed'} isOpen={isModalOpen} onClose={() => setIsModalOpen(false)} activeConditionsMap={activeConditionsMap} matchMode={matchMode} onApply={handleApply} choices={filterChoices.data} choicesLoading={filterChoices.isPending} choicesError={filterChoices.isError} retryChoices={() => void filterChoices.refetch()} />
  </div>;
};
