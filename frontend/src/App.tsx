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

  const groupedSessions = React.useMemo(() => {
    const groups: Record<string, typeof availableSessions> = {};
    for (const s of availableSessions) {
      const year = s.date.slice(0, 4);
      if (!groups[year]) groups[year] = [];
      groups[year].push(s);
    }
    return groups;
  }, [availableSessions]);

  const { minDate, maxDate } = React.useMemo(() => {
    if (availableSessions.length === 0) return { minDate: '', maxDate: '' };
    const dates = availableSessions.map((s) => s.date).filter(Boolean).sort();
    return { minDate: dates[0] || '', maxDate: dates[dates.length - 1] || '' };
  }, [availableSessions]);

  const selectedAsOfDate = customSessionDate || latestDate;
  const selectedSessionMeta = availableSessions.find((s) => s.date === selectedAsOfDate);
  const activeRevision = selectedSessionMeta?.revision || latestRevision;
  const isHistoricalSelected = Boolean(selectedAsOfDate && latestDate && selectedAsOfDate !== latestDate);

  const handleDateSelect = React.useCallback(
    (inputDate: string) => {
      if (!inputDate) return;
      if (latestDate && inputDate >= latestDate) {
        setCustomSessionDate(null);
        return;
      }
      const exact = availableSessions.find((s) => s.date === inputDate);
      if (exact) {
        setCustomSessionDate(exact.date === latestDate ? null : exact.date);
        return;
      }
      const preceding = availableSessions.find((s) => s.date <= inputDate);
      if (preceding) {
        setCustomSessionDate(preceding.date === latestDate ? null : preceding.date);
      } else if (availableSessions.length > 0) {
        const earliest = availableSessions[availableSessions.length - 1];
        setCustomSessionDate(earliest.date === latestDate ? null : earliest.date);
      }
    },
    [availableSessions, latestDate]
  );

  return (
    <div className={`app-frame${sidebarHidden ? ' app-frame--sidebar-hidden' : ''}`}>
      <a href="#workspace" className="skip-link">Skip to results workspace</a>
      {!sidebarHidden && <Navbar activeTab={activeTab} onTabChange={setActiveTab} onHideSidebar={() => setSidebarHidden(true)} sessionDate={activeTab === 'screener' ? selectedAsOfDate : undefined} />}

      <main id="workspace" className={`workspace${activeTab === 'charts' ? ' workspace--charts' : ''}${sidebarHidden ? ' workspace--sidebar-hidden' : ''}`} tabIndex={-1}>
        {sidebarHidden && <button type="button" className="workspace-sidebar-reopen" aria-label="Show sidebar" title="Show sidebar" onClick={() => setSidebarHidden(false)}><PanelLeftOpen size={17}/></button>}
        {activeTab === 'screener' && (
          <div className="workspace-heading">
            <div className="session-picker-wrapper">
              <div className="session-label">
                <CalendarDays size={16} />
                <span>Session:</span>
              </div>
              <select
                className={`session-select${isHistoricalSelected ? ' session-select--historical' : ''}`}
                value={selectedAsOfDate}
                aria-label="Select trading session"
                onChange={(e) => {
                  const val = e.target.value;
                  setCustomSessionDate(val === latestDate ? null : val);
                }}
              >
                {availableSessions.length > 0 ? (
                  Object.entries(groupedSessions).map(([year, list]) => (
                    <optgroup key={year} label={year}>
                      {list.map((s) => (
                        <option key={s.date} value={s.date}>
                          {new Date(`${s.date}T00:00:00`).toLocaleDateString('en-IN', {
                            day: 'numeric',
                            month: 'short',
                            year: 'numeric',
                          })}
                          {s.date === latestDate ? ' (Latest)' : ''}
                        </option>
                      ))}
                    </optgroup>
                  ))
                ) : (
                  <option value={selectedAsOfDate}>
                    {selectedAsOfDate
                      ? new Date(`${selectedAsOfDate}T00:00:00`).toLocaleDateString('en-IN', {
                          day: 'numeric',
                          month: 'short',
                          year: 'numeric',
                        })
                      : 'Checking latest session'}
                  </option>
                )}
              </select>
              <input
                type="date"
                className={`session-date-input${isHistoricalSelected ? ' session-date-input--historical' : ''}`}
                value={selectedAsOfDate}
                min={minDate}
                max={maxDate}
                title="Jump directly to a date"
                aria-label="Jump directly to date"
                onChange={(e) => handleDateSelect(e.target.value)}
              />
              {isHistoricalSelected && (
                <button
                  type="button"
                  className="button button-ghost button-sm session-reset-btn"
                  onClick={() => setCustomSessionDate(null)}
                  title="Reset to latest trading session"
                >
                  Reset to Latest
                </button>
              )}
            </div>
          </div>
        )}
        {revisionFailed && <p role="alert" className="notice">The latest data release could not be loaded. <button className="button button-ghost" onClick={() => void refreshRevision()}>Retry</button></p>}
        {activeTab === 'screener' ? (
          <ExploreTab
            selectedAsOfDate={selectedAsOfDate}
            datasetRevision={activeRevision}
            onRefreshRevision={async () => (await refreshRevision()).data?.immutableRevision}
          />
        ) : activeTab === 'charts' ? (
          <React.Suspense fallback={<p role="status">Loading chart workspace…</p>}>
            <ChartsTab datasetRevision={latestRevision}/>
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
