import React from 'react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { screenerApi } from './api/screenerApi';
import { Navbar } from './components/Navbar';
import { ExploreTab } from './components/ExploreTab';
import { NewListingsTab } from './components/NewListingsTab';
import { SessionDatePicker } from './components/SessionDatePicker';
import { PanelLeftOpen } from 'lucide-react';
import { useLocalStorageState } from './hooks/useLocalStorageState';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      staleTime: 5 * 60 * 1000,
    },
  },
});

const ChartsTab = React.lazy(() => import('./components/ChartsTab'));
const ThematicRrgTab = React.lazy(() => import('./components/ThematicRrgTab'));

const ScreenerAppContent: React.FC = () => {
  const [storedTab, setActiveTab] = useLocalStorageState<'screener' | 'ipo' | 'charts' | 'news' | 'rrg'>('nexus-scanner.ui.active-tab.v1', 'screener');
  // Live News is temporarily hidden; restore saved News sessions to the screener.
  const activeTab = storedTab === 'news' ? 'screener' : storedTab;
  const [sidebarHidden, setSidebarHidden] = useLocalStorageState('nexus-scanner.ui.sidebar-hidden.v1', false);
  const [chartRevision, setChartRevision] = React.useState<string | undefined>();

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

  const selectedAsOfDate = customSessionDate || latestDate;
  const selectedSessionMeta = availableSessions.find((s) => s.date === selectedAsOfDate);
  const activeRevision = selectedSessionMeta?.revision || latestRevision;

  return (
    <div className={`app-frame${sidebarHidden ? ' app-frame--sidebar-hidden' : ''}`}>
      <a href="#workspace" className="skip-link">Skip to results workspace</a>
      {!sidebarHidden && <Navbar activeTab={activeTab} onTabChange={tab => { setChartRevision(undefined); setActiveTab(tab); }} onHideSidebar={() => setSidebarHidden(true)} sessionDate={activeTab === 'screener' ? selectedAsOfDate : undefined} />}

      <main id="workspace" className={`workspace${activeTab === 'charts' ? ' workspace--charts' : ''}${activeTab === 'rrg' ? ' workspace--rrg' : ''}${sidebarHidden ? ' workspace--sidebar-hidden' : ''}`} tabIndex={-1}>
        {sidebarHidden && <button type="button" className="workspace-sidebar-reopen" aria-label="Show sidebar" title="Show sidebar" onClick={() => setSidebarHidden(false)}><PanelLeftOpen size={17}/></button>}
        {activeTab === 'screener' && (
          <div className="workspace-heading">
            <div className="session-picker-wrapper">
              <div className="session-label">
                <span>Session:</span>
              </div>
              <SessionDatePicker
                selectedDate={selectedAsOfDate}
                latestDate={latestDate}
                availableSessions={availableSessions}
                onChange={setCustomSessionDate}
              />
            </div>
          </div>
        )}
        {revisionFailed && <p role="alert" className="notice">The latest data release could not be loaded. <button className="button button-ghost" onClick={() => void refreshRevision()}>Retry</button></p>}
        {activeTab === 'screener' ? (
          <ExploreTab
            selectedAsOfDate={selectedAsOfDate}
            datasetRevision={activeRevision}
            onRefreshRevision={async () => (await refreshRevision()).data?.immutableRevision}
            availableSessions={availableSessions}
            onSelectSession={setCustomSessionDate}
            onOpenFullChart={(_symbol, revision) => { setChartRevision(revision); setActiveTab('charts'); }}
          />
        ) : activeTab === 'rrg' ? (
          <React.Suspense fallback={<p role="status">Loading Thematic RRG…</p>}>
            <ThematicRrgTab datasetRevision={latestRevision} />
          </React.Suspense>
        ) : activeTab === 'charts' ? (
          <React.Suspense fallback={<p role="status">Loading chart workspace…</p>}>
            <ChartsTab datasetRevision={chartRevision ?? latestRevision}/>
          </React.Suspense>
        ) : (
          <NewListingsTab key={latestRevision} datasetRevision={latestRevision} selectedAsOfDate={latestDate} />
        )}
      </main>
    </div>
  );
};


export const App: React.FC = () => (
  <QueryClientProvider client={queryClient}>
    <ScreenerAppContent />
  </QueryClientProvider>
);

export default App;
