import React, { useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { screenerApi } from '../api/screenerApi';
import { ArrowUpDown, Play, SlidersHorizontal, X, ChevronDown, Search, SearchX } from 'lucide-react';
import {CopyResults} from './CopyResults';
import { ActiveCondition, ExpressionNode, MatchMode, ScreenerRunRequest } from '../types/screener';
import { NEXUS_CONDITION_CATALOG } from '../data/conditionCatalog';
import { isAvailableCondition } from '../utils/filterAvailability';
import { PRESET_CATALOG } from '../data/presetCatalog';
import { explainCondition } from '../utils/nqlParser';
import { ResultsTable } from './ResultsTable';
import { ScreenerModal } from './ScreenerModal';
import { useFilterChoices } from '../hooks/useFilterChoices';
import { usePhoneLayout } from '../hooks/usePhoneLayout';
import { tableLayout } from '../utils/tableLayout';
import { useLocalStorageState } from '../hooks/useLocalStorageState';
import { Pagination } from './Pagination';
import { SymbolWithLogo } from './SymbolWithLogo';
import { pagePlaceholder } from '../utils/pagePlaceholder';
import { useNextScreenPage, screenPageStaleTime } from '../hooks/useNextScreenPage';
import { useTableWindow } from '../hooks/useTableWindow';
import { hasUnavailableConditions, UnavailableConditions, UNAVAILABLE_CONDITIONS_MESSAGE } from './UnavailableConditions';
import { IpoDetailsCard } from './IpoDetailsCard';
import { useSymbolHoverCard } from '../hooks/useSymbolHoverCard';
import { Dialog } from './Dialog';
import type { IPORow } from '../types/screener';

type IpoColumnGroup = 'Company' | 'Listing' | 'Offer' | 'Subscription' | 'Performance' | 'Allotment' | 'Research';
interface IpoColumn { id: string; label: string; group: IpoColumnGroup; value: (row: IPORow) => string; sortField?: typeof IPO_SORT_FIELDS[number] }
const IPO_SORT_FIELDS = ['listingDate','currentPrice','turnoverCrore','marketCapCrore','deliveryPct'] as const;
const IPO_COLUMN_GROUPS: IpoColumnGroup[] = ['Company','Listing','Offer','Subscription','Performance','Allotment','Research'];
const IPO_DEFAULT_COLUMNS = ['company','listingDate','currentPrice','turnoverCrore','marketCapCrore','deliveryPct','sectorIndustry'];
const text = (value: unknown) => value == null || value === '' ? '—' : String(value);
const dateOnly = (value: string | null | undefined) => {
  if (!value) return '—';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleDateString('en-IN', {
    day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata',
  });
};
const ipoNumberFormatter = new Intl.NumberFormat('en-IN', {maximumFractionDigits: 2});
const amount = (value: number | null | undefined, suffix = '') => value == null ? '—'
  : `${ipoNumberFormatter.format(value)}${suffix}`;
const rupees = (value: number | null | undefined, suffix = '') => value == null ? '—'
  : `₹${amount(value, suffix)}`;
const multiple = (value: number | null | undefined) => value == null ? '—' : `${amount(value, '×')}`;
const ipoColumns: IpoColumn[] = [
  {id:'company',label:'Company',group:'Company',value:row=>row.name || row.symbol},
  {id:'symbol',label:'Symbol',group:'Company',value:row=>row.symbol},
  {id:'isin',label:'ISIN',group:'Company',value:row=>text(row.isin)},
  {id:'securityId',label:'Security ID',group:'Company',value:row=>text(row.securityId)},
  {id:'sectorIndustry',label:'Sector / industry',group:'Company',value:row=>[row.sector,row.industry].filter(Boolean).join(' / ') || '—'},
  {id:'listingDate',label:'Listing date',group:'Listing',value:row=>text(row.listingDate),sortField:'listingDate'},
  {id:'listingAge',label:'Listing age (days)',group:'Listing',value:row=>amount(row.listingAgeCalendarDays)},
  {id:'currentPrice',label:'Last price',group:'Listing',value:row=>rupees(row.currentPrice),sortField:'currentPrice'},
  {id:'turnoverCrore',label:'Daily turnover',group:'Listing',value:row=>rupees(row.turnoverCrore,' Cr'),sortField:'turnoverCrore'},
  {id:'marketCapCrore',label:'Market cap',group:'Listing',value:row=>rupees(row.marketCapCrore,' Cr'),sortField:'marketCapCrore'},
  {id:'deliveryPct',label:'Delivery',group:'Listing',value:row=>row.deliveryPct == null ? '—' : `${amount(row.deliveryPct,'%')}`,sortField:'deliveryPct'},
  {id:'issuePrice',label:'Issue price',group:'Offer',value:row=>rupees(row.ipoResearch?.issuePrice ?? row.issuePrice)},
  {id:'issueSize',label:'Issue size',group:'Offer',value:row=>rupees(row.ipoResearch?.offer?.issueSizeCrore ?? row.ipoResearch?.scanx?.issueSize,' Cr')},
  {id:'freshIssue',label:'Fresh issue',group:'Offer',value:row=>rupees(row.ipoResearch?.offer?.freshIssueCrore,' Cr')},
  {id:'offerForSale',label:'Offer for sale',group:'Offer',value:row=>rupees(row.ipoResearch?.offer?.offerForSaleCrore,' Cr')},
  {id:'priceBand',label:'Price band',group:'Offer',value:row=>{const issue=row.ipoResearch?.ipoDecode?.issue; const offer=row.ipoResearch?.scanx?.offer; const low=issue?.priceBandLow ?? offer?.floorPrice; const high=issue?.priceBandHigh ?? offer?.ceilingPrice; return low == null && high == null ? '—' : `${low == null ? '—' : rupees(low)} – ${high == null ? '—' : rupees(high)}`;}},
  {id:'lotSize',label:'Lot size',group:'Offer',value:row=>amount(row.ipoResearch?.ipoDecode?.issue?.lotSize ?? row.ipoResearch?.scanx?.offer?.lotSize)},
  {id:'minimumInvestment',label:'Minimum investment',group:'Offer',value:row=>rupees(row.ipoResearch?.ipoDecode?.issue?.minInvestment)},
  {id:'issueType',label:'Issue type',group:'Offer',value:row=>text(row.ipoResearch?.ipoDecode?.issue?.issueType)},
  {id:'offerOpens',label:'Offer opens',group:'Offer',value:row=>text(row.ipoResearch?.scanx?.offer?.startDate)},
  {id:'offerCloses',label:'Offer closes',group:'Offer',value:row=>text(row.ipoResearch?.scanx?.offer?.endDate)},
  {id:'subscriptionTotal',label:'Total subscription',group:'Subscription',value:row=>multiple(row.ipoResearch?.subscription?.total)},
  {id:'subscriptionRetail',label:'Retail subscription',group:'Subscription',value:row=>multiple(row.ipoResearch?.subscription?.retail)},
  {id:'subscriptionNii',label:'NII subscription',group:'Subscription',value:row=>multiple(row.ipoResearch?.subscription?.nii)},
  {id:'subscriptionInstitutional',label:'Institutional subscription',group:'Subscription',value:row=>multiple(row.ipoResearch?.subscription?.institutional)},
  {id:'listingPrice',label:'Listing price',group:'Performance',value:row=>rupees(row.ipoResearch?.provider?.listingPrice ?? row.listingPrice)},
  {id:'listingGain',label:'Listing gain',group:'Performance',value:row=>{const value=row.ipoResearch?.provider?.listingGainPct; return value == null ? '—' : `${amount(value,'%')}`;}},
  {id:'gmp',label:'GMP',group:'Performance',value:row=>rupees(row.ipoResearch?.provider?.gmp)},
  {id:'gmpPct',label:'GMP %',group:'Performance',value:row=>{const value=row.ipoResearch?.provider?.gmpPct; return value == null ? '—' : `${amount(value,'%')}`;}},
  {id:'anchorLockInEnd',label:'Anchor lock-in end',group:'Performance',value:row=>text(row.anchorLockInEnd)},
  {id:'anchorLockInDays',label:'Anchor unlock dates',group:'Performance',value:row=>row.anchorLockInCalendar?.filter(item=>item.unlockDate).map(item=>dateOnly(item.unlockDate)).join(', ') || '—'},
  {id:'nextAnchorLockIn',label:'Next anchor lock-in',group:'Performance',value:row=>text(row.nextAnchorLockInDate)},
  {id:'allotmentStatus',label:'Allotment status',group:'Allotment',value:row=>text(row.ipoResearch?.ipoDecode?.allotmentStatus)},
  {id:'allotmentDate',label:'Allotment date',group:'Allotment',value:row=>dateOnly(row.ipoResearch?.ipoDecode?.allotmentDate ?? row.ipoResearch?.scanx?.allotmentDate)},
  {id:'refundDate',label:'Refund date',group:'Allotment',value:row=>text(row.ipoResearch?.ipoDecode?.refundDate)},
  {id:'dematCreditDate',label:'Demat credit date',group:'Allotment',value:row=>text(row.ipoResearch?.ipoDecode?.dematCreditDate)},
  {id:'registrar',label:'Registrar',group:'Allotment',value:row=>text(row.ipoResearch?.ipoDecode?.registrar)},
  {id:'applications',label:'Applications',group:'Research',value:row=>amount(row.ipoResearch?.ipoDecode?.issue?.totalApplications)},
  {id:'documentCount',label:'Published documents',group:'Research',value:row=>amount(row.ipoResearch?.ipoDecode?.documentCount)},
  {id:'qualityGrade',label:'Quality grade',group:'Research',value:row=>text(row.ipoResearch?.ipoDecode?.issue?.qualityGrade)},
  {id:'leadManagers',label:'Lead managers',group:'Research',value:row=>text(row.ipoResearch?.ipoDecode?.issue?.leadManagers)},
  {id:'companyDescription',label:'Company description',group:'Research',value:row=>text(row.ipoResearch?.scanx?.companyDetail ?? row.ipoResearch?.ipoDecode?.issue?.about)},
  {id:'revenue',label:'Revenue (Cr)',group:'Research',value:row=>rupees(row.ipoResearch?.ipoDecode?.issue?.revenueCrore,' Cr')},
  {id:'profit',label:'Profit after tax (Cr)',group:'Research',value:row=>rupees(row.ipoResearch?.ipoDecode?.issue?.profitCrore,' Cr')},
  {id:'roe',label:'Return on net worth',group:'Research',value:row=>{const value=row.ipoResearch?.ipoDecode?.issue?.roePct; return value == null ? '—' : `${amount(value,'%')}`;}},
  {id:'peUpper',label:'IPO P/E at upper band',group:'Research',value:row=>multiple(row.ipoResearch?.ipoDecode?.issue?.peAtUpper)},
  {id:'valuationPe',label:'Valuation P/E',group:'Research',value:row=>multiple(row.ipoResearch?.ipoDecode?.valuation?.pe)},
  {id:'valuationPb',label:'Valuation P/B',group:'Research',value:row=>multiple(row.ipoResearch?.ipoDecode?.valuation?.pb)},
  {id:'valuationEvEbitda',label:'EV / EBITDA',group:'Research',value:row=>multiple(row.ipoResearch?.ipoDecode?.valuation?.evEbitda)},
  {id:'peerMedianPe',label:'Peer median P/E',group:'Research',value:row=>multiple(row.ipoResearch?.ipoDecode?.valuation?.peerMedianPe)},
  {id:'valuationVerdict',label:'Valuation view',group:'Research',value:row=>text(row.ipoResearch?.ipoDecode?.valuation?.verdict)},
  {id:'ipoDetailUpdated',label:'IPO details updated',group:'Research',value:row=>text(row.ipoDetailStatus?.lastSuccessAt ?? row.ipoResearch?.ipoDecode?.fetchedAt)},
  {id:'timelineStatus',label:'IPO timeline status',group:'Research',value:row=>text(row.ipoResearch?.ipoDecode?.timelineStatus)},
  {id:'ipoDecodeSources',label:'IPO Decode data sections',group:'Research',value:row=>amount(row.ipoResearch?.ipoDecode?.endpoints?.length)},
  {id:'providerFailedEndpoints',label:'Unavailable data sections',group:'Research',value:row=>amount(row.ipoDetailStatus?.failedEndpoints?.length)},
  {id:'gmpHistoryPoints',label:'GMP history points',group:'Research',value:row=>amount(row.ipoResearch?.ipoDecode?.gmpHistory?.length)},
  {id:'peerCoverage',label:'Peer data',group:'Research',value:row=>row.ipoResearch?.ipoDecode?.peerAvailability?.available == null ? '—' : row.ipoResearch.ipoDecode.peerAvailability.available ? 'Available' : text(row.ipoResearch.ipoDecode.peerAvailability.reason ?? 'Unavailable')},
  {id:'financialPeriods',label:'Financial periods',group:'Research',value:row=>amount(row.ipoResearch?.scanx?.financials?.length)},
  {id:'purposeCount',label:'Issue purposes',group:'Research',value:row=>amount(row.ipoResearch?.scanx?.purpose?.length)},
  {id:'strengthCount',label:'Business strengths',group:'Research',value:row=>amount(row.ipoResearch?.scanx?.strengths?.length)},
  {id:'riskCount',label:'Risk factors',group:'Research',value:row=>amount(row.ipoResearch?.scanx?.risks?.length)},
  {id:'managementCount',label:'Management members',group:'Research',value:row=>amount(row.ipoResearch?.scanx?.management?.length)},
  {id:'drhp',label:'DRHP',group:'Research',value:row=>row.ipoResearch?.scanx?.drhpUrl ? 'Available' : '—'},
  {id:'conflictCount',label:'Source conflicts',group:'Research',value:row=>amount(row.ipoResearch?.conflicts?.length)},
];

export const NewListingsTab: React.FC<{ datasetRevision?: string; selectedAsOfDate: string }> = ({ datasetRevision, selectedAsOfDate }) => {
  const [periodFilter, setPeriodFilter] = useLocalStorageState<'30d' | '90d' | '6m' | '1y' | 'all'>('nexus-scanner.ipo.period.v1', '1y');
  const [search, setSearch] = useLocalStorageState('nexus-scanner.ipo.search.v1', '');
  const [sort, setSort] = useLocalStorageState<{ field: 'listingDate' | 'currentPrice' | 'turnoverCrore' | 'marketCapCrore' | 'deliveryPct'; direction: 'asc' | 'desc' }>('nexus-scanner.ipo.sort.v1', { field: 'listingDate', direction: 'desc' });
  const [page, setPage] = useState(1);
  const [isFilterModalOpen, setIsFilterModalOpen] = useState(false);
  const filterChoices = useFilterChoices(isFilterModalOpen, datasetRevision);
  const [isColumnPickerOpen, setIsColumnPickerOpen] = useState(false);
  const [columnSearch, setColumnSearch] = useState('');
  const [columnGroup, setColumnGroup] = useState<IpoColumnGroup>('Listing');
  const [savedIpoColumnIds, setSavedIpoColumnIds] = useLocalStorageState<string[]>('nexus-scanner.ipo.columns.v1', IPO_DEFAULT_COLUMNS);
  const [showScreenResults, setShowScreenResults] = useState(false);
  const [matchMode, setMatchMode] = useLocalStorageState<MatchMode>('nexus-scanner.ipo.match-mode.v1', 'all');
  const [conditions, setConditions] = useLocalStorageState<Record<string, ActiveCondition>>('nexus-scanner.ipo.conditions.v1', {});
  const hasUnavailable = hasUnavailableConditions(conditions);
  const [screenPage, setScreenPage] = useState(1);
  const [screenSort, setScreenSort] = useState<{ field: string; direction: 'asc' | 'desc' }>({ field: 'rvol', direction: 'desc' });
  const [pageSize, setPageSize] = useState(50);
  const [screenPageSize, setScreenPageSize] = useState(15);
  const scrollRef = useRef<HTMLDivElement>(null);
  const ipoOverview = useSymbolHoverCard<IPORow>('ipo-details');

  const ipoQuery = useQuery({
    queryKey: ['ipos', datasetRevision],
    queryFn: () => screenerApi.getIpoCatalogue(),
    enabled: Boolean(datasetRevision),
  });
  const { isLoading } = ipoQuery;
  const ipoData = ipoQuery.data?.records ?? [];

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
  const visibleIpos = useMemo(() => filteredIpos.slice((currentPage - 1) * pageSize, currentPage * pageSize), [filteredIpos, currentPage, pageSize]);
  const selectedIpoColumnIds = Array.isArray(savedIpoColumnIds) ? savedIpoColumnIds : IPO_DEFAULT_COLUMNS;
  const phone = usePhoneLayout();
  const customIpoColumns = selectedIpoColumnIds.length !== IPO_DEFAULT_COLUMNS.length
    || IPO_DEFAULT_COLUMNS.some(id => !selectedIpoColumnIds.includes(id));
  const layout = tableLayout(ipoColumns.filter(column => column.id === 'company' || selectedIpoColumnIds.includes(column.id)), 'ipo', phone, customIpoColumns);
  const visibleIpoColumns = layout.columns;
  const ipoWindow = useTableWindow(visibleIpos, visibleIpos, visibleIpoColumns.length);
  const matchingIpoColumns = ipoColumns.filter(column => `${column.label} ${column.group}`.toLowerCase().includes(columnSearch.trim().toLowerCase()));
  const pickerIpoColumns = columnSearch.trim() ? matchingIpoColumns : ipoColumns.filter(column => column.group === columnGroup);
  const updatePeriod = (value: typeof periodFilter) => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
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
    expressionTree, sort: screenSort, page: screenPage, pageSize: screenPageSize,
  }), [datasetRevision, selectedAsOfDate, listingSymbols, expressionTree, screenSort, screenPage, screenPageSize]);
  const screenQuery = useQuery({
    queryKey: ['ipoScreen', screenRequest],
    queryFn: () => {
      if (hasUnavailable) throw new Error(UNAVAILABLE_CONDITIONS_MESSAGE);
      return screenerApi.runScreen(screenRequest);
    },
    enabled: !hasUnavailable && showScreenResults && Boolean(selectedAsOfDate) && listingSymbols.length > 0,
    staleTime: screenPageStaleTime(screenRequest),
    placeholderData: (previous, query) => pagePlaceholder(previous, query?.queryKey[1], screenRequest),
  });
  useNextScreenPage('ipoScreen', screenRequest, screenQuery.data,
    showScreenResults && !hasUnavailable && !screenQuery.isFetching && !screenQuery.isError);
  const applyFilters = (next: Record<string, ActiveCondition>, mode: MatchMode) => {
    setConditions(next);
    setMatchMode(mode);
    setScreenPage(1);
    setShowScreenResults(true);
  };
  const activeConditions = Object.values(conditions).filter(isAvailableCondition);
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
        <div className="screen-buttons">
          {Object.keys(conditions).length > 0 && <button className="button button-ghost" onClick={() => {setConditions({}); setScreenPage(1);}}>Reset</button>}
          {showScreenResults && <button className="button button-secondary" onClick={() => setShowScreenResults(false)}>Listings</button>}
          <button className="button button-secondary" onClick={() => setIsFilterModalOpen(true)}><SlidersHorizontal size={15} />Filters{Object.keys(conditions).length > 0 && <span className="count-badge">{Object.keys(conditions).length}</span>}</button>
          <button className="button button-primary" onClick={() => {if (hasUnavailable) return; setScreenPage(1); setShowScreenResults(true);}} disabled={hasUnavailable || !filteredIpos.length || screenQuery.isFetching}><Play size={14} />Run</button>
        </div>
      </div>
      {activeConditions.length > 0 && <div className="active-filters">{Object.entries(conditions).filter(([, condition]) => isAvailableCondition(condition)).map(([key, condition]) => {
        const definition = NEXUS_CONDITION_CATALOG.find(item => item.id === condition.conditionId) ?? PRESET_CATALOG.find(item => item.id === condition.conditionId);
        const label = ['FUNDAMENTAL_METRIC', 'mom_return', 'PRICE_CHANGE_PCT'].includes(condition.conditionId)
          ? explainCondition(condition).explanation : definition?.label ?? condition.conditionId;
        return <span key={key} className="filter-chip">{label}<button aria-label={`Remove ${label}`} onClick={() => removeCondition(key)}><X size={13} /></button></span>;
      })}</div>}
      <UnavailableConditions conditions={conditions} onRemove={removeCondition} />
    </section>
    {showScreenResults && !hasUnavailable && listingSymbols.length > 0 ? <ResultsTable data={screenQuery.data} isLoading={screenQuery.isLoading} isFetching={screenQuery.isFetching}
      loadExportRows={()=>screenerApi.getExportRows({...screenRequest,datasetRevision:screenQuery.data?.immutableRevision ?? datasetRevision})}
      symbolSearch={search} onSymbolSearchChange={value => {setSearch(value); setPage(1); setScreenPage(1);}}
      isError={screenQuery.isError} error={screenQuery.error} onRetry={() => void screenQuery.refetch()} onPageChange={setScreenPage} onPageSizeChange={size => {setScreenPageSize(size); setScreenPage(1);}}
      onSortChange={(field, direction) => {setScreenSort({field, direction}); setScreenPage(1);}} currentSort={screenSort} />
      : <section className="results-surface" aria-label="IPO listings">
        <div className="results-toolbar"><div className="result-count"><strong>{!isLoading && (!ipoQuery.isError || ipoQuery.data) ? filteredIpos.length.toLocaleString('en-IN') : '-'}</strong><span>new listings</span></div>
          <label className="results-symbol-search"><Search size={13} aria-hidden="true" /><input type="search" aria-label="Search IPO listings" placeholder="Search symbol" value={search} onChange={event => {if (scrollRef.current) scrollRef.current.scrollTop = 0; setSearch(event.target.value); setPage(1); setScreenPage(1);}} /></label>
          <div className="results-actions">
            <CopyResults loadRows={()=>Promise.resolve(filteredIpos)} revision={datasetRevision} disabled={!filteredIpos.length || isLoading}/>
            <button type="button" className="button button-secondary" aria-label="Customize IPO columns" onClick={() => setIsColumnPickerOpen(true)}><SlidersHorizontal size={14} /><span>Columns</span></button>
          </div>
        </div>
        <div className="table-viewport"><div ref={scrollRef} className="table-scroll" tabIndex={0} aria-label="IPO table, scroll for more columns" onScroll={event => {if (!ipoOverview.active?.pinned) ipoOverview.dismiss(); ipoWindow.onScroll(event);}}>
          <table className={`data-table ipo-table${ipoWindow.enabled ? ' windowed-table' : ''}`} aria-rowcount={visibleIpos.length + 1} style={layout.style}><caption className="sr-only">Newly listed companies</caption>
            <colgroup>{visibleIpoColumns.map(column => <col key={column.id} style={{width:layout.columnWidth(column)}} />)}</colgroup>
            <thead><tr>{visibleIpoColumns.map(column => <th scope="col" key={column.id} aria-sort={column.sortField && sort.field === column.sortField ? sort.direction === 'asc' ? 'ascending' : 'descending' : column.sortField ? 'none' : undefined}>
              {column.sortField ? <button onClick={() => updateSort(column.sortField!)}>{column.label}<ArrowUpDown size={13} /></button> : column.label}
            </th>)}</tr></thead>
            <tbody>{ipoWindow.top > 0 && <tr aria-hidden="true" className="table-spacer"><td colSpan={visibleIpoColumns.length} style={{height: ipoWindow.top}} /></tr>}
              {isLoading ? Array.from({length: 10}, (_, i) => <tr key={i} className="skeleton-row">{visibleIpoColumns.map(column => <td key={column.id}><span className="skeleton" /></td>)}</tr>)
              : ipoQuery.isError && !ipoQuery.data ? <tr><td colSpan={visibleIpoColumns.length}><div role="alert" className="data-state"><h2>IPO catalogue could not be loaded.</h2><button className="button button-secondary" onClick={() => void ipoQuery.refetch()}>Retry</button></div></td></tr>
              : !filteredIpos.length ? <tr><td colSpan={visibleIpoColumns.length}><div className="data-state"><SearchX size={28} /><h2>No new listings recorded for selected period window.</h2><p>Choose a longer period or clear your search.</p></div></td></tr>
              : ipoWindow.rows.map((row, index) => <tr key={ipoWindow.first + index} aria-rowindex={ipoWindow.first + index + 2}>
                {visibleIpoColumns.map(column => <td key={column.id} className={column.id === 'company' || column.id === 'sectorIndustry' ? '' : 'numeric'}>{column.id === 'company' ? <button type="button" className="ipo-company-trigger" aria-label={`IPO details for ${row.name || row.symbol}`} title="Hover or click for IPO details"
                  aria-haspopup="dialog" aria-expanded={ipoOverview.active?.row.symbol === row.symbol} aria-controls={`ipo-details-${row.symbol}`}
                  onMouseEnter={event => { if (!phone) ipoOverview.open(row, event.currentTarget, false); }}
                  onMouseLeave={() => { if (!phone) ipoOverview.scheduleClose(); }}
                  onFocus={event => { if (!phone) ipoOverview.open(row, event.currentTarget, false); }}
                  onBlur={event => {if (!phone && !document.getElementById(`ipo-details-${row.symbol}`)?.contains(event.relatedTarget)) ipoOverview.scheduleClose();}}
                  onClick={event => ipoOverview.active?.row.symbol === row.symbol && ipoOverview.active.pinned
                    ? ipoOverview.dismiss() : ipoOverview.open(row, event.currentTarget, true)}
                  onKeyDown={event => {
                    if (event.key === 'Escape') ipoOverview.dismiss();
                    if ((event.key === 'Tab' && !event.shiftKey) || event.key === 'ArrowDown') {
                      event.preventDefault();
                      ipoOverview.enter(row, event.currentTarget);
                    }
                  }}>
                  <SymbolWithLogo symbol={row.symbol} name={row.name} />
                </button> : column.id === 'sectorIndustry' ? <><div className="cell-label truncate" title={row.sector}>{row.sector}</div><div className="cell-secondary truncate" title={row.industry}>{row.industry}</div></>
                  : <span className={column.id==='currentPrice'?'cell-strong':''} title={column.value(row)}>{column.value(row)}</span>}</td>)}
              </tr>)}
              {ipoWindow.bottom > 0 && <tr aria-hidden="true" className="table-spacer"><td colSpan={visibleIpoColumns.length} style={{height: ipoWindow.bottom}} /></tr>}
            </tbody>
          </table>
        </div>
        <Pagination page={currentPage} pageSize={pageSize} total={filteredIpos.length} busy={isLoading || (ipoQuery.isError && !ipoQuery.data)} onPageChange={page => {if (scrollRef.current) scrollRef.current.scrollTop = 0; setPage(page);}} onPageSizeChange={size => {ipoOverview.dismiss(); if (scrollRef.current) scrollRef.current.scrollTop = 0; setPageSize(size); setPage(1);}} />
        </div>
      </section>}
    {isColumnPickerOpen && <Dialog label="Customize IPO columns" className="column-dialog" onClose={() => setIsColumnPickerOpen(false)}>
      <div className="dialog-header"><div><h2>Customize IPO columns</h2><p>{visibleIpoColumns.length} selected · choose IPO fields for the table</p></div><button type="button" className="icon-button" aria-label="Close IPO column customization" onClick={() => setIsColumnPickerOpen(false)}><X size={18} /></button></div>
      <div className="column-dialog-content">
        <label className="column-search"><Search size={14} /><input type="search" aria-label="Search IPO columns" placeholder="Search IPO fields" value={columnSearch} onChange={event => setColumnSearch(event.target.value)} /></label>
        <div className="column-dialog-toolbar"><span>{columnSearch.trim() ? `${pickerIpoColumns.length} results` : `${pickerIpoColumns.filter(column => column.id === 'company' || selectedIpoColumnIds.includes(column.id)).length} selected in ${columnGroup.toLowerCase()}`}</span><div>
          <button type="button" className="button button-ghost" onClick={() => setSavedIpoColumnIds(ipoColumns.map(column => column.id))}>Select all</button>
          <button type="button" className="button button-ghost" onClick={() => setSavedIpoColumnIds(IPO_DEFAULT_COLUMNS)}>Reset</button>
        </div></div>
        {!columnSearch.trim() && <div className="column-category-tabs" role="tablist" aria-label="IPO column categories">{IPO_COLUMN_GROUPS.map(group => <button key={group} type="button" role="tab" aria-selected={columnGroup===group} onClick={() => setColumnGroup(group)}>{group}</button>)}</div>}
        <div className="column-options" role="group" aria-label={columnSearch.trim()?'IPO column search results':`${columnGroup} IPO columns`}>
          {pickerIpoColumns.length ? pickerIpoColumns.map(column => <label key={column.id} className="column-picker-option">
            <input type="checkbox" aria-label={column.label} checked={column.id==='company'||selectedIpoColumnIds.includes(column.id)} disabled={column.id==='company'}
              onChange={event => setSavedIpoColumnIds(current => event.target.checked
                ? [...new Set([...(Array.isArray(current)?current:IPO_DEFAULT_COLUMNS),column.id])]
                : (Array.isArray(current)?current:IPO_DEFAULT_COLUMNS).filter(id=>id!==column.id))} />
            <span>{column.label}</span>{columnSearch.trim() && <small>{column.group}</small>}
          </label>) : <p className="column-search-empty">No matching IPO fields.</p>}
        </div>
      </div>
    </Dialog>}
    <ScreenerModal key={isFilterModalOpen ? 'open' : 'closed'} isOpen={isFilterModalOpen} onClose={() => setIsFilterModalOpen(false)} activeConditionsMap={conditions} matchMode={matchMode} onApply={applyFilters} choices={filterChoices.data} choicesLoading={filterChoices.isPending} choicesError={filterChoices.isError} retryChoices={() => void filterChoices.refetch()} />
    {ipoOverview.active && ipoOverview.id && <IpoDetailsCard key={ipoOverview.active.row.symbol} row={ipoOverview.active.row} id={ipoOverview.id} left={ipoOverview.active.left} top={ipoOverview.active.top} placement={ipoOverview.active.placement}
      onClose={ipoOverview.close} onMouseEnter={ipoOverview.cancelClose}
      onMouseLeave={ipoOverview.scheduleClose} />}
  </div>;
};
