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
  const [hoveredDate, setHoveredDate] = useState<string | null>(null);
  const [sessionSymbols, setSessionSymbols] = useState<Record<string, string[]>>({});
  const [loadingSymbols, setLoadingSymbols] = useState(false);
  const [symbolFilter, setSymbolFilter] = useState('');
  const [visibleSymbolCount, setVisibleSymbolCount] = useState(INITIAL_SYMBOLS);
  const [copied, setCopied] = useState(false);
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
  const displayPoint = points.find(point => point.date === hoveredDate) ?? selectedPoint;
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
    setHoveredDate(null);
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
    setHoveredDate(null);
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
  const chartWidth = Math.max(640, points.length * 11);
  const chartHeight = 144;
  const maxCount = Math.max(1, ...points.map(point => point.count));
  const isStale = lastRunFingerprint !== null && lastRunFingerprint !== fingerprint;

  return (
    <section aria-label="Backtest history" className="scan-history">
      <header className="scan-history-header">
        <div className="scan-history-title">
          <h2>Scan history</h2>
          <span>{targetSessions.length} sessions</span>
        </div>
        <div className="scan-history-controls">
          <div className="scan-history-segment" aria-label="History range">
            {([30, 60, 120, 'all'] as const).map(option => (
              <button key={option} type="button" disabled={status === 'running'}
                aria-pressed={range === option} onClick={() => changeRange(option)}>
                {option === 'all' ? 'All' : `${option}d`}
              </button>
            ))}
          </div>
          {status === 'running' ? (
            <button type="button" className="button button-secondary" onClick={stop}>
              <Square size={14} /> Stop
            </button>
          ) : status !== 'idle' ? (
            <button type="button" className="button button-primary" disabled={!canRun} onClick={() => void startScan()}>
              <Play size={14} /> {points.length ? 'Run again' : 'Run scan'}
            </button>
          ) : null}
          {onClose && (
            <button type="button" className="scan-history-icon-button" aria-label="Close scan history" onClick={close}>
              <X size={17} />
            </button>
          )}
        </div>
      </header>

      {!compatibility.compatible && (
        <p className="scan-history-notice" role="alert"><AlertTriangle size={16} />{compatibility.reason}</p>
      )}
      {isStale && status !== 'running' && (
        <p className="scan-history-notice">Filters have changed. Run the scan again to refresh these results.</p>
      )}
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
              {summary.failedSessions} {summary.failedSessions === 1 ? 'session' : 'sessions'} unavailable. Results use {summary.evaluatedSessions} evaluated {summary.evaluatedSessions === 1 ? 'session' : 'sessions'}.
            </p>
          )}
          <div className="scan-history-summary">
            <div><span>Average matches</span><strong>{summary.averageMatches.toLocaleString('en-IN')}</strong></div>
            <div><span>Peak</span><strong>{summary.peakCount.toLocaleString('en-IN')}</strong></div>
            <div><span>Evaluated with matches</span><strong>{summary.frequencyPct}%</strong></div>
          </div>

          <div className="scan-history-chart-heading">
            <div>
              <h3>Matches over time</h3>
              <p>Select a bar to inspect that session.</p>
            </div>
            {displayPoint && <p><strong>{formatDate(displayPoint.date)}</strong><span>{displayPoint.count.toLocaleString('en-IN')} matches</span></p>}
          </div>
          <div className="scan-history-chart-scroll">
            <div style={{ minWidth: chartWidth }}>
              <svg className="scan-history-chart" viewBox={`0 0 ${chartWidth} ${chartHeight}`} preserveAspectRatio="none"
                role="group" aria-label="Historical matches by trading session">
                {[0.25, 0.5, 0.75].map(step => (
                  <line key={step} x1="0" x2={chartWidth} y1={chartHeight * step} y2={chartHeight * step} className="scan-history-gridline" />
                ))}
                {points.map((point, index) => {
                  const slot = chartWidth / points.length;
                  const height = point.status === 'success' ? Math.max(2, point.count / maxCount * (chartHeight - 16)) : 5;
                  const selected = selectedPoint?.date === point.date;
                  return (
                    <g key={point.date} role="button" tabIndex={0}
                      aria-label={`${formatDate(point.date)}: ${point.count} matches`}
                      onClick={() => void selectPoint(point)}
                      onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); void selectPoint(point); } }}
                      onMouseEnter={() => setHoveredDate(point.date)}
                      onMouseLeave={() => setHoveredDate(null)}>
                      <rect x={index * slot} y={0} width={slot} height={chartHeight} fill="transparent" />
                      <rect x={index * slot + Math.max(1, slot * .15)} y={chartHeight - height}
                        width={Math.max(3, slot * .7)} height={height} rx={2}
                        className={point.status !== 'success' ? 'scan-history-bar scan-history-bar-error' : selected ? 'scan-history-bar scan-history-bar-selected' : 'scan-history-bar'} />
                    </g>
                  );
                })}
              </svg>
              <div className="scan-history-dates">
                {[0, .25, .5, .75, 1].map(position => (
                  <span key={position}>{formatDate(points[Math.round((points.length - 1) * position)].date)}</span>
                ))}
              </div>
            </div>
          </div>

          {selectedPoint && (
            <div className="scan-history-results">
              <div className="scan-history-results-header">
                <div>
                  <h3>{formatDate(selectedPoint.date)} <span>{selectedPoint.count.toLocaleString('en-IN')} matches</span></h3>
                  <p>{selectedPoint.status === 'success' ? 'Stocks matching your filters on this date' : selectedPoint.error ?? 'Session unavailable'}</p>
                </div>
                <div className="scan-history-result-actions">
                  <label className="scan-history-search">
                    <Search size={15} aria-hidden="true" />
                    <span className="sr-only">Filter symbols</span>
                    <input value={symbolFilter} onChange={event => { setSymbolFilter(event.target.value); setVisibleSymbolCount(INITIAL_SYMBOLS); }}
                      placeholder="Filter symbols" disabled={!currentSymbols.length} />
                  </label>
                  <button type="button" className="button button-secondary" onClick={() => void copySymbols()} disabled={!currentSymbols.length}>
                    {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? 'Copied' : 'Copy all'}
                  </button>
                  <button type="button" className="button button-primary" onClick={() => onSelectSession(selectedPoint.date)}
                    disabled={selectedPoint.status !== 'success'}>
                    Open session <ChevronRight size={15} />
                  </button>
                </div>
              </div>

              {sectorCounts.length > 0 && (
                <details className="scan-history-sectors">
                  <summary>Sector breakdown <span>{sectorCounts.length} sectors</span></summary>
                  <div>{sectorCounts.map(([sector, count]) => (
                    <span key={sector}>{sector}<strong>{count.toLocaleString('en-IN')}</strong></span>
                  ))}</div>
                </details>
              )}

              {loadingSymbols ? (
                <p className="scan-history-empty">Loading symbols for this session...</p>
              ) : visibleSymbols.length ? (
                <>
                  <div className="scan-history-symbols" aria-label="Matching symbols">
                    {visibleSymbols.map(symbol => <span key={symbol}>{symbol}</span>)}
                  </div>
                  <div className="scan-history-results-footer">
                    <span>Showing {visibleSymbols.length.toLocaleString('en-IN')} of {filteredSymbols.length.toLocaleString('en-IN')} symbols</span>
                    {visibleSymbols.length < filteredSymbols.length && (
                      <button type="button" onClick={() => setVisibleSymbolCount(count => count + INITIAL_SYMBOLS)}>Show more</button>
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
        <div className="scan-history-intro">
          <h3>See how this screen performed over time</h3>
          <p>Run your current filters across {targetSessions.length} archived trading sessions.</p>
          <button type="button" className="button button-primary" disabled={!canRun} onClick={() => void startScan()}>
            <Play size={14} /> Start frequency scan
          </button>
        </div>
      ) : status === 'stopped' ? (
        <p className="scan-history-empty">Scan stopped. Run it again to refresh the timeline.</p>
      ) : null}
    </section>
  );
};
