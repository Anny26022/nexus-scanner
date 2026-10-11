import React, { useState } from 'react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { screenerApi } from './api/screenerApi';
import { Navbar } from './components/Navbar';
import { ExploreTab } from './components/ExploreTab';
import { NewListingsTab } from './components/NewListingsTab';
import { BookmarkPlus, CalendarDays } from 'lucide-react';
import { useLocalStorageState } from './hooks/useLocalStorageState';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      staleTime: 5 * 60 * 1000,
    },
  },
});

const ScreenerAppContent: React.FC = () => {
  const [activeTab, setActiveTab] = useLocalStorageState<'screener' | 'ipo'>('nexus-scanner.ui.active-tab.v1', 'screener');
  const [watchlistToast, setWatchlistToast] = useState<string | null>(null);

  const { data: revisionData, isError: revisionFailed, refetch: refreshRevision } = useQuery({
    queryKey: ['revisionCurrent'],
    queryFn: () => screenerApi.getCurrentRevision(),
    staleTime: 0,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });

  const selectedAsOfDate = revisionData?.latestSessionDate || '';

  const handleAddToWatchlist = (symbols: string[]) => {
    setWatchlistToast(
      `Added ${symbols.length} symbol${symbols.length !== 1 ? 's' : ''} to watchlist`
    );
    setTimeout(() => setWatchlistToast(null), 2500);
  };

  return (
    <div className="app-frame">
      <a href="#workspace" className="skip-link">Skip to results workspace</a>
      <Navbar activeTab={activeTab} onTabChange={setActiveTab} />

      <main id="workspace" className="workspace" tabIndex={-1}>
        <div className="workspace-heading">
          <div className="session-label"><CalendarDays size={16} /><span>{selectedAsOfDate ? <>Session <strong>{new Date(`${selectedAsOfDate}T00:00:00`).toLocaleDateString('en-IN', {day: 'numeric', month: 'short', year: 'numeric'})}</strong></> : 'Checking latest session'}</span></div>
        </div>
        {revisionFailed && <p role="alert" className="notice">The latest data release could not be loaded. <button className="button button-ghost" onClick={() => void refreshRevision()}>Retry</button></p>}
        {activeTab === 'screener' ? (
          <ExploreTab
            selectedAsOfDate={selectedAsOfDate}
            datasetRevision={revisionData?.immutableRevision}
            onRefreshRevision={async () => (await refreshRevision()).data?.immutableRevision}
            onAddToWatchlist={handleAddToWatchlist}
          />
        ) : (
          <NewListingsTab key={revisionData?.immutableRevision} datasetRevision={revisionData?.immutableRevision} selectedAsOfDate={selectedAsOfDate} />
        )}
      </main>

      {watchlistToast && (
        <div role="status" className="toast">
          <BookmarkPlus className="w-4 h-4 text-emerald-400" />
          <span>{watchlistToast}</span>
        </div>
      )}
    </div>
  );
};

export const App: React.FC = () => (
  <QueryClientProvider client={queryClient}>
    <ScreenerAppContent />
  </QueryClientProvider>
);

export default App;
