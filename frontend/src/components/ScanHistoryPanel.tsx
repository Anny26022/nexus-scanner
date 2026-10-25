import React, { useMemo, useRef, useState } from 'react';
import { AlertTriangle, Check, ChevronRight, Copy, Play, Search, Square, X } from 'lucide-react';
import { useMountEffect } from '../hooks/useMountEffect';
import type { ExpressionNode, UniverseType } from '../types/screener';
import {
  checkScanCompatibility,
  computeScanHistorySummary,
  executeScanHistory,
  loadSessionSymbols,
  type ScanHistoryPoint,
  type ScanHistoryProgress,
  type ScanSession,
} from '../api/scanHistoryEngine';
import { Button } from './Button';
import { ScanHistoryChart } from './ScanHistoryChart';

interface ScanHistoryPanelProps {
  expressionTree: ExpressionNode;
  universe: UniverseType;
  customSymbols?: string[];
  availableSessions: ScanSession[];
  currentSessionDate: string;
  onSelectSession: (date: string) => void;
  onClose?: () => void;
}

type RangeOption = 30 | 60 | 120 | 'all';
type ScanStatus = 'idle' | 'running' | 'completed' | 'stopped';
const INITIAL_SYMBOLS = 80;

function formatDate(date: string): string {
  return new Date(`${date}T00:00:00`).toLocaleDateString('en-IN', {
    day: 'numeric', month: 'short', year: 'numeric',
  });
}

export const ScanHistoryPanel: React.FC<ScanHistoryPanelProps> = ({
  expressionTree, universe, customSymbols, availableSessions, currentSessionDate, onSelectSession, onClose,
}) => {
  const [range, setRange] = useState<RangeOption>(60);
  const [status, setStatus] = useState<ScanStatus>('idle');
  const [points, setPoints] = useState<ScanHistoryPoint[]>([]);
  const [progress, setProgress] = useState<ScanHistoryProgress | null>(null);
  const [lastRunFingerprint, setLastRunFingerprint] = useState<string | null>(null);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [sessionSymbols, setSessionSymbols] = useState<Record<string, string[]>>({});
  const [loadingSymbols, setLoadingSymbols] = useState(false);
  const [symbolFilter, setSymbolFilter] = useState('');
  const [visibleSymbolCount, setVisibleSymbolCount] = useState(INITIAL_SYMBOLS);
  const [copied, setCopied] = useState(false);
  const [detail, setDetail] = useState<'stocks' | 'sectors'>('stocks');
  const [showAllSectors, setShowAllSectors] = useState(false);
  const scanController = useRef<AbortController | null>(null);
  const symbolsController = useRef<AbortController | null>(null);

  const cancelRequests = () => {
    scanController.current?.abort();
    symbolsController.current?.abort();
    scanController.current = null;
    symbolsController.current = null;
  };
  useMountEffect(() => cancelRequests);

  const targetSessions = useMemo(() => {
    const sessions = [...availableSessions].sort((a, b) => b.date.localeCompare(a.date));
    const anchor = sessions.findIndex(session => session.date === currentSessionDate);
    const window = sessions.slice(anchor < 0 ? 0 : anchor);
    return (range === 'all' ? window : window.slice(0, range)).reverse();
  }, [availableSessions, currentSessionDate, range]);
  const fingerprint = useMemo(() => `${universe}:${(customSymbols ?? []).slice().sort().join(',')}:${JSON.stringify(expressionTree)}`,
    [universe, customSymbols, expressionTree]);
  const compatibility = useMemo(() => checkScanCompatibility(expressionTree), [expressionTree]);
  const canRun = compatibility.compatible && targetSessions.length > 0;
  const summary = useMemo(() => computeScanHistorySummary(points, targetSessions.length), [points, targetSessions.length]);
  const selectedPoint = points.find(point => point.date === selectedDate) ?? points.at(-1) ?? null;
  const currentSymbols = selectedPoint ? (sessionSymbols[selectedPoint.date] ?? []) : [];
  const filteredSymbols = symbolFilter.trim()
    ? currentSymbols.filter(symbol => symbol.toUpperCase().includes(symbolFilter.trim().toUpperCase()))
    : currentSymbols;
  const visibleSymbols = filteredSymbols.slice(0, visibleSymbolCount);
  const sectorCounts = selectedPoint?.sectorCounts
    ? Object.entries(selectedPoint.sectorCounts).sort((a, b) => b[1] - a[1])
    : [];

  const selectPoint = async (point: ScanHistoryPoint) => {
    symbolsController.current?.abort();
    symbolsController.current = null;
    setLoadingSymbols(false);
    setSelectedDate(point.date);
    setShowAllSectors(false);
    setSymbolFilter('');
    setCopied(false);
    setVisibleSymbolCount(INITIAL_SYMBOLS);
    if (sessionSymbols[point.date] || point.status !== 'success' || point.count === 0) return;
    const session = targetSessions.find(item => item.date === point.date);
    if (!session) return;
    const controller = new AbortController();
    symbolsController.current = controller;
    setLoadingSymbols(true);
    try {
      const symbols = await loadSessionSymbols(session, expressionTree, universe, customSymbols, controller.signal);
      if (!controller.signal.aborted) setSessionSymbols(previous => ({ ...previous, [point.date]: symbols }));
    } catch (error) {
      if (!controller.signal.aborted) console.warn('Could not load historical symbols', error);
    } finally {
      if (symbolsController.current === controller) {
        symbolsController.current = null;
        setLoadingSymbols(false);
      }
    }
  };

  const startScan = async () => {
    if (!compatibility.compatible) return;
    cancelRequests();
    setLoadingSymbols(false);
    setPoints([]);
    setSelectedDate(null);
    setCopied(false);
    setStatus('running');
    setProgress({ current: 0, total: targetSessions.length, pct: 0 });
    setLastRunFingerprint(fingerprint);
    const controller = new AbortController();
    scanController.current = controller;
    const streamed = new Map<string, ScanHistoryPoint>();
    try {
      const result = await executeScanHistory(targetSessions, expressionTree, universe, customSymbols, {
        concurrency: 2,
        signal: controller.signal,
        onProgress: (nextProgress, point) => {
          if (controller.signal.aborted) return;
          streamed.set(point.date, point);
          setProgress(nextProgress);
          setPoints(targetSessions.flatMap(session => streamed.get(session.date) ?? []));
        },
      });
      if (controller.signal.aborted) return;
      setPoints(result.points);
      setStatus('completed');
      const latest = result.points.at(-1);
      if (latest) void selectPoint(latest);
    } catch (error) {
      if (!controller.signal.aborted) {
        console.error('Scan history failed', error);
        setStatus('stopped');
      }
    } finally {
      if (scanController.current === controller) scanController.current = null;
    }
  };

  const changeRange = (next: RangeOption) => {
    setRange(next);
    setStatus('idle');
    setPoints([]);
    setProgress(null);
    setSelectedDate(null);
    setLastRunFingerprint(null);
  };
  const close = () => { cancelRequests(); onClose?.(); };
  const stop = () => { cancelRequests(); setStatus('stopped'); };
  const copySymbols = async () => {
    try {
      await navigator.clipboard.writeText(currentSymbols.join(', '));
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  const isStale = lastRunFingerprint !== null && lastRunFingerprint !== fingerprint;
  const successful = points.filter(point => point.status === 'success');
  const latest = successful.at(-1);
  const selectedIndex = selectedPoint ? points.indexOf(selectedPoint) : -1;
  const previous = points.slice(0, Math.max(0, selectedIndex)).reverse().find(point => point.status === 'success');
  const change = selectedPoint?.status === 'success' && previous ? selectedPoint.count - previous.count : null;
  const topSectors = showAllSectors ? sectorCounts : sectorCounts.slice(0, 10);
  const sectorMax = sectorCounts[0]?.[1] ?? 1;
  const n = (value: number) => value.toLocaleString('en-IN');

  return (
    <section aria-label="Backtest history" className="scan-history">
      <header className="history-head">
        <div className="history-title">
          <h2>Scan history</h2>
          <p>How many stocks this screen matched in each of the last {targetSessions.length} sessions.</p>
        </div>
        <div className="history-controls">
          <div className="scan-history-segment" aria-label="History range">
            {([30, 60, 120, 'all'] as const).map(option => (
              <button key={option} type="button" disabled={status === 'running'}
                aria-pressed={range === option} onClick={() => changeRange(option)}>
                {option === 'all' ? 'All' : `${option}d`}
              </button>
            ))}
          </div>
          {status === 'running' ? (
            <Button variant="secondary" onClick={stop}><Square size={13} /> Stop</Button>
          ) : status !== 'idle' ? (
            <Button variant="primary" disabled={!canRun} onClick={() => void startScan()}>
              <Play size={13} /> {points.length ? 'Run again' : 'Run scan'}
            </Button>
          ) : null}
          {onClose && (
            <button type="button" className="scan-history-icon-button" aria-label="Close scan history" onClick={close}>
              <X size={16} />
            </button>
          )}
        </div>
      </header>

      {!compatibility.compatible && <p className="scan-history-notice" role="alert"><AlertTriangle size={15} />{compatibility.reason}</p>}
      {isStale && status !== 'running' && <p className="scan-history-notice">Filters changed since this run. Run again to refresh.</p>}
      {status === 'running' && progress && (
        <div className="scan-history-progress" role="status" aria-live="polite">
          <span>Scanning {progress.current} of {progress.total} sessions</span>
          <span>{progress.pct}%</span>
          <div className="scan-history-progress-track"><div style={{ width: `${progress.pct}%` }} /></div>
        </div>
      )}

      {points.length > 0 ? (
        <>
          {summary.failedSessions > 0 && (
            <p className="scan-history-notice" role="status">
              {summary.failedSessions} {summary.failedSessions === 1 ? 'session' : 'sessions'} unavailable, shown as gaps. Figures use the other {summary.evaluatedSessions}.
            </p>
          )}
          <dl className="history-stats">
            {latest && <div><dt>Latest</dt><dd>{n(latest.count)}</dd></div>}
            <div><dt>Average</dt><dd>{n(Math.round(summary.averageMatches))}</dd></div>
            <div><dt>Range</dt><dd>{n(summary.lowestCount)}<span>–</span>{n(summary.peakCount)}</dd></div>
            <div><dt>Sessions with matches</dt><dd>{summary.frequencyPct}%</dd></div>
          </dl>

          <ScanHistoryChart points={points} selected={selectedPoint?.date ?? null} onSelect={point => void selectPoint(point)} />
          <p className="history-hint">Select a point to see that session’s stocks below · ← → to step</p>

          {selectedPoint && (
            <div className="history-session">
              <div className="history-session-head">
                <div>
                  <h3>{formatDate(selectedPoint.date)}</h3>
                  <p>{selectedPoint.status === 'success'
                    ? <><strong>{n(selectedPoint.count)}</strong> matches{change != null && change !== 0 &&
                      <span className={change > 0 ? 'positive' : 'negative'}> {change > 0 ? '+' : '−'}{n(Math.abs(change))} vs previous session</span>}</>
                    : selectedPoint.error ?? 'Session unavailable'}</p>
                </div>
                <div className="history-session-actions">
                  <Button variant="secondary" onClick={() => void copySymbols()} disabled={!currentSymbols.length}>
                    {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? 'Copied' : 'Copy'}
                  </Button>
                  <Button variant="primary" onClick={() => onSelectSession(selectedPoint.date)} disabled={selectedPoint.status !== 'success'}>
                    Open in screener <ChevronRight size={14} />
                  </Button>
                </div>
              </div>

              <div className="history-tabs">
                <div className="scan-history-segment" role="group" aria-label="Session detail">
                  <button type="button" aria-pressed={detail === 'stocks'} onClick={() => setDetail('stocks')}>Stocks</button>
                  <button type="button" aria-pressed={detail === 'sectors'} disabled={!sectorCounts.length} onClick={() => setDetail('sectors')}>
                    Sectors{sectorCounts.length ? ` · ${sectorCounts.length}` : ''}
                  </button>
                </div>
                {detail === 'stocks' && (
                  <label className="scan-history-search">
                    <Search size={14} aria-hidden="true" />
                    <span className="sr-only">Filter symbols</span>
                    <input value={symbolFilter} onChange={event => { setSymbolFilter(event.target.value); setVisibleSymbolCount(INITIAL_SYMBOLS); }}
                      placeholder="Filter symbols" disabled={!currentSymbols.length} />
                  </label>
                )}
              </div>

              {detail === 'sectors' && sectorCounts.length > 0 ? (
                <>
                  <ul className="history-sectors">{topSectors.map(([sector, count]) => (
                    <li key={sector}>
                      <span className="history-sector-name" title={sector}>{sector}</span>
                      <span className="history-sector-bar"><span style={{ width: `${count / sectorMax * 100}%` }} /></span>
                      <span className="history-sector-count">{n(count)}</span>
                    </li>
                  ))}</ul>
                  {sectorCounts.length > topSectors.length && (
                    <button type="button" className="history-more" onClick={() => setShowAllSectors(true)}>Show all {sectorCounts.length} sectors</button>
                  )}
                </>
              ) : loadingSymbols ? (
                <p className="scan-history-empty">Loading stocks for this session…</p>
              ) : visibleSymbols.length ? (
                <>
                  <div className="scan-history-symbols" aria-label="Matching symbols">
                    {visibleSymbols.map(symbol => <span key={symbol}>{symbol}</span>)}
                  </div>
                  <div className="scan-history-results-footer">
                    <span>Showing {n(visibleSymbols.length)} of {n(filteredSymbols.length)} symbols</span>
                    {visibleSymbols.length < filteredSymbols.length && (
                      <button type="button" className="history-more" onClick={() => setVisibleSymbolCount(count => count + INITIAL_SYMBOLS)}>Show more</button>
                    )}
                  </div>
                </>
              ) : (
                <p className="scan-history-empty">
                  {selectedPoint.status !== 'success' ? 'This session could not be evaluated.'
                    : selectedPoint.count === 0 ? 'No stocks matched on this date.'
                    : symbolFilter ? 'No symbols match your search.' : 'No symbols available.'}
                </p>
              )}
            </div>
          )}
        </>
      ) : status === 'idle' ? (
        <div className="history-intro">
          <p>Runs your current filters on each archived session and charts how many stocks matched.</p>
          <Button variant="primary" disabled={!canRun} onClick={() => void startScan()}>
            <Play size={13} /> Start frequency scan
          </Button>
        </div>
      ) : status === 'stopped' ? (
        <p className="scan-history-empty">Scan stopped. Run it again to refresh the chart.</p>
      ) : null}
    </section>
  );
};
