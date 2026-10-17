import React from 'react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { screenerApi } from './api/screenerApi';
import { Navbar } from './components/Navbar';
import { ExploreTab } from './components/ExploreTab';
import { NewListingsTab } from './components/NewListingsTab';
import { CalendarDays, PanelLeftOpen } from 'lucide-react';
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

const ScreenerAppContent: React.FC = () => {
  const [activeTab, setActiveTab] = useLocalStorageState<'screener' | 'ipo' | 'charts'>('nexus-scanner.ui.active-tab.v1', 'screener');
  const [sidebarHidden, setSidebarHidden] = useLocalStorageState('nexus-scanner.ui.sidebar-hidden.v1', false);

  const { data: revisionData, isError: revisionFailed, refetch: refreshRevision } = useQuery({
    queryKey: ['revisionCurrent'],
    queryFn: () => screenerApi.getCurrentRevision(),
    staleTime: 0,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });

  const selectedAsOfDate = revisionData?.latestSessionDate || '';

  return (
    <div className={`app-frame${sidebarHidden ? ' app-frame--sidebar-hidden' : ''}`}>
      <a href="#workspace" className="skip-link">Skip to results workspace</a>
      {!sidebarHidden && <Navbar activeTab={activeTab} onTabChange={setActiveTab} onHideSidebar={() => setSidebarHidden(true)} sessionDate={activeTab === 'charts' ? undefined : selectedAsOfDate} />}

      <main id="workspace" className={`workspace${activeTab === 'charts' ? ' workspace--charts' : ''}${sidebarHidden ? ' workspace--sidebar-hidden' : ''}`} tabIndex={-1}>
        {sidebarHidden && <button type="button" className="workspace-sidebar-reopen" aria-label="Show sidebar" title="Show sidebar" onClick={() => setSidebarHidden(false)}><PanelLeftOpen size={17}/></button>}
        {activeTab !== 'charts' && <div className="workspace-heading">
          <div className="session-label"><CalendarDays size={16} /><span>{selectedAsOfDate ? <>Session <strong>{new Date(`${selectedAsOfDate}T00:00:00`).toLocaleDateString('en-IN', {day: 'numeric', month: 'short', year: 'numeric'})}</strong></> : 'Checking latest session'}</span></div>
        </div>}
        {revisionFailed && <p role="alert" className="notice">The latest data release could not be loaded. <button className="button button-ghost" onClick={() => void refreshRevision()}>Retry</button></p>}
        {activeTab === 'screener' ? (
          <ExploreTab
            selectedAsOfDate={selectedAsOfDate}
            datasetRevision={revisionData?.immutableRevision}
            onRefreshRevision={async () => (await refreshRevision()).data?.immutableRevision}
          />
        ) : activeTab === 'charts' ? (
          <React.Suspense fallback={<p role="status">Loading chart workspace…</p>}>
            <ChartsTab datasetRevision={revisionData?.immutableRevision}/>
          </React.Suspense>
        ) : (
          <NewListingsTab key={revisionData?.immutableRevision} datasetRevision={revisionData?.immutableRevision} selectedAsOfDate={selectedAsOfDate} />
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
