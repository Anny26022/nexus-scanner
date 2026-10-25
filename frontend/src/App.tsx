import React from 'react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { screenerApi } from './api/screenerApi';
import { Navbar, type AppTab } from './components/Navbar';
import { ExploreTab } from './components/ExploreTab';
import { NewListingsTab } from './components/NewListingsTab';
import { SessionDatePicker } from './components/SessionDatePicker';
import { PanelLeftOpen } from 'lucide-react';
import { useLocalStorageState } from './hooks/useLocalStorageState';
import { Button } from './components/Button';
import { CommandPalette } from './components/CommandPalette';
import { useTheme } from './hooks/useTheme';
import { useMountEffect } from './hooks/useMountEffect';
import { loadGrid, openSymbolInCharts } from './chart/storage';
import { chartQuery } from './chart/chartQuery';
import { writeScreenToStorage, type ScreenDefinition } from './utils/savedScreens';
import { SCREEN_STORAGE_KEYS } from './utils/screenStorageKeys';
import { useStoredState } from './storage/useStoredState';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      staleTime: 5 * 60 * 1000,
    },
  },
});

const ChartsTab = React.lazy(() => import('./components/ChartsTab'));
const MarketTab = React.lazy(() => import('./components/MarketTab'));
const EarningsTab = React.lazy(() => import('./components/EarningsTab'));
const RotationTab = React.lazy(() => import('./components/RotationTab'));

const ScreenerAppContent: React.FC = () => {
  const [storedTab, setActiveTab] = useLocalStorageState<AppTab | 'news'>('nexus-scanner.ui.active-tab.v1', 'screener');
  // Live News is temporarily hidden; restore saved News sessions to the screener.
  const activeTab = storedTab === 'news' ? 'screener' : storedTab;
  const [screenerMounted, setScreenerMounted] = React.useState(activeTab === 'screener');
  if (activeTab === 'screener' && !screenerMounted) setScreenerMounted(true);
  const [sidebarHidden, setSidebarHidden] = useLocalStorageState('nexus-scanner.ui.sidebar-hidden.v1', false);
  const [chartSnapshot, setChartSnapshot] = React.useState<{revision?: string; sessionDate: string}>();
  const {choice: theme, setChoice: setTheme} = useTheme();
  const [paletteOpen, setPaletteOpen] = React.useState(false);
  // Bumped when a saved screen is loaded from outside the Screener so it re-reads its stored state.
  const [screenerKey, setScreenerKey] = React.useState(0);

  useMountEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen(open => !open);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  const navigate = (tab: AppTab) => { setChartSnapshot(undefined); setActiveTab(tab); };
  const loadScreen = (screen: ScreenDefinition) => {
    writeScreenToStorage(screen);
    setScreenerKey(key => key + 1);
    navigate('screener');
  };
  const openSymbol = (symbol: string) => {
    if (openSymbolInCharts(symbol)) navigate('charts');
  };

  const { data: revisionData, isError: revisionFailed, refetch: refreshRevision } = useQuery({
    queryKey: ['revisionCurrent'],
    queryFn: () => screenerApi.getCurrentRevision(),
    staleTime: 0,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });

  const { data: sessionsList = [] } = useQuery({
    queryKey: ['availableSessions'],
    queryFn: () => screenerApi.getAvailableSessions(),
    staleTime: 60_000,
  });

  // The Screener owns the universe; reading the same stored key keeps this in step with no hand-off.
  const [universe] = useStoredState<unknown>(SCREEN_STORAGE_KEYS.universe, 'mainboard');
  const etfUniverse = universe === 'etf';
  const [customSessionDate, setCustomSessionDate] = React.useState<string | null>(null);

  const latestDate = revisionData?.latestSessionDate || '';
  const latestRevision = revisionData?.immutableRevision || '';

  const availableSessions = React.useMemo(() => {
    const list = sessionsList.filter((s) => s.date !== latestDate);
    if (latestDate && latestRevision) {
      list.unshift({
        date: latestDate,
        label: 'Latest',
        isHistorical: false,
        revision: latestRevision,
      });
    }
    return list;
  }, [sessionsList, latestDate, latestRevision]);

  const selectedAsOfDate = etfUniverse && activeTab === 'screener' ? latestDate : customSessionDate || latestDate;
  const selectedSessionMeta = availableSessions.find((s) => s.date === selectedAsOfDate);
  const activeRevision = selectedSessionMeta?.revision || latestRevision;
  // Start the saved chart's data request while the lazy workspace code loads.
  useQuery({
    ...chartQuery(chartSnapshot?.revision ?? activeRevision, loadGrid().tiles[0].symbol, chartSnapshot?.sessionDate ?? selectedAsOfDate),
    enabled: activeTab === 'charts' && Boolean(chartSnapshot?.revision ?? activeRevision),
    notifyOnChangeProps: [],
  });

  return (
    <div className={`app-frame${sidebarHidden ? ' app-frame--sidebar-hidden' : ''}`}>
      <a href="#workspace" className="skip-link">Skip to results workspace</a>
      {/* Phones always get the top bar with the tabs; "hidden" only collapses the desktop sidebar. */}
      <Navbar
        activeTab={activeTab}
        onTabChange={navigate}
        onHideSidebar={() => setSidebarHidden(true)}
        onOpenSearch={() => setPaletteOpen(true)}
        theme={theme}
        onThemeChange={setTheme}
        sessionControl={activeTab === 'screener' ? etfUniverse ? <span className="field-label">Latest ETF snapshot</span> : <SessionDatePicker
          selectedDate={selectedAsOfDate}
          latestDate={latestDate}
          availableSessions={availableSessions}
          onChange={setCustomSessionDate}
        /> : undefined}
      />

      <main id="workspace" className={`workspace${activeTab === 'charts' ? ' workspace--charts' : ''}${sidebarHidden ? ' workspace--sidebar-hidden' : ''}`} tabIndex={-1}>
        {sidebarHidden && <button type="button" className="workspace-sidebar-reopen" aria-label="Show sidebar" title="Show sidebar" onClick={() => setSidebarHidden(false)}><PanelLeftOpen size={17}/></button>}
        {revisionFailed && <p role="alert" className="notice">The latest data release could not be loaded. <Button variant="ghost" onClick={() => void refreshRevision()}>Retry</Button></p>}
        {screenerMounted && <div style={{display: activeTab === 'screener' ? 'contents' : 'none'}}>
          <ExploreTab
            key={screenerKey}
            selectedAsOfDate={selectedAsOfDate}
            datasetRevision={activeRevision}
            onRefreshRevision={async () => (await refreshRevision()).data?.immutableRevision}
            availableSessions={availableSessions}
            onSelectSession={setCustomSessionDate}
            onOpenFullChart={(_symbol, revision, sessionDate) => { setChartSnapshot({revision, sessionDate: sessionDate ?? selectedAsOfDate}); setActiveTab('charts'); }}
          />
        </div>}
        {activeTab === 'charts' ? (
          <React.Suspense fallback={<p role="status">Loading chart workspace…</p>}>
            <ChartsTab latestRevision={(chartSnapshot?.sessionDate ?? selectedAsOfDate) === latestDate ? latestRevision : undefined} datasetRevision={chartSnapshot?.revision ?? activeRevision} sessionDate={chartSnapshot?.sessionDate ?? selectedAsOfDate}/>
          </React.Suspense>
        ) : activeTab === 'market' ? (
          <React.Suspense fallback={<p role="status">Loading market overview…</p>}>
            <MarketTab
              datasetRevision={activeRevision}
              sessionDate={selectedAsOfDate}
              onScreenSector={sector => loadScreen({
                universe: 'mainboard', matchMode: 'all', query: '', sort: {field: 'marketCap', direction: 'desc'},
                conditions: {sector: {instanceId: 'sector', conditionId: 'SECTOR', parameters: {values: [sector]}}},
              })}
            />
          </React.Suspense>
        ) : activeTab === 'earnings' ? (
          <React.Suspense fallback={<p role="status">Loading earnings…</p>}>
            <EarningsTab datasetRevision={activeRevision} onOpenChart={openSymbol} />
          </React.Suspense>
        ) : activeTab === 'rotation' ? (
          <React.Suspense fallback={<p role="status">Loading rotation…</p>}>
            <RotationTab datasetRevision={activeRevision} onOpenChart={openSymbol} />
          </React.Suspense>
        ) : activeTab === 'ipo' ? (
          <NewListingsTab key={latestRevision} datasetRevision={latestRevision} selectedAsOfDate={latestDate} />
        ) : null}
      </main>
      {paletteOpen && <CommandPalette
        onClose={() => setPaletteOpen(false)}
        onNavigate={navigate}
        onLoadScreen={loadScreen}
        onOpenSymbol={openSymbol}
        onThemeChange={setTheme}
        datasetRevision={activeRevision}
        sessionDate={selectedAsOfDate}
      />}
    </div>
  );
};


export const App: React.FC = () => (
  <QueryClientProvider client={queryClient}>
    <ScreenerAppContent />
  </QueryClientProvider>
);

export default App;
