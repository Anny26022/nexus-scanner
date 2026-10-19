import React, { useState, useMemo, useRef } from 'react';
import {
  BarChart3,
  Play,
  Square,
  RotateCcw,
  Calendar,
  TrendingUp,
  Award,
  Layers,
  Search,
  Copy,
  Check,
  X,
  ChevronRight,
  AlertTriangle,
  Info,
} from 'lucide-react';
import { useMountEffect } from '../hooks/useMountEffect';
import type { ExpressionNode, UniverseType } from '../types/screener';
import {
  executeScanHistory,
  computeScanHistorySummary,
  checkScanCompatibility,
  loadSessionSymbols,
  type ScanSession,
  type ScanHistoryPoint,
  type ScanHistorySummary,
  type ScanHistoryProgress,
} from '../api/scanHistoryEngine';

interface ScanHistoryPanelProps {
  expressionTree: ExpressionNode;
  universe: UniverseType;
  customSymbols?: string[];
  availableSessions: ScanSession[];
  currentSessionDate: string;
  onSelectSession: (date: string) => void;
  onClose: () => void;
}

type RangeOption = 30 | 60 | 120 | 'all';

export const ScanHistoryPanel: React.FC<ScanHistoryPanelProps> = ({
  expressionTree,
  universe,
  customSymbols,
  availableSessions,
  currentSessionDate,
  onSelectSession,
  onClose,
}) => {
  const [range, setRange] = useState<RangeOption>(60);
  const [status, setStatus] = useState<'idle' | 'running' | 'completed' | 'stopped'>('idle');
  const [points, setPoints] = useState<ScanHistoryPoint[]>([]);
  const [lastRunFingerprint, setLastRunFingerprint] = useState<string | null>(null);
  const [progress, setProgress] = useState<ScanHistoryProgress | null>(null);
  const [hoveredPoint, setHoveredPoint] = useState<ScanHistoryPoint | null>(null);
  const [selectedPoint, setSelectedPoint] = useState<ScanHistoryPoint | null>(null);
  const [sessionSymbols, setSessionSymbols] = useState<Record<string, string[]>>({});
  const [loadingSymbols, setLoadingSymbols] = useState(false);
  const [symbolFilter, setSymbolFilter] = useState('');
  const [copied, setCopied] = useState(false);

  const abortControllerRef = useRef<AbortController | null>(null);
  const symbolsControllerRef = useRef<AbortController | null>(null);

  const cancelRequests = () => {
    abortControllerRef.current?.abort();
    symbolsControllerRef.current?.abort();
    abortControllerRef.current = null;
    symbolsControllerRef.current = null;
  };
  useMountEffect(() => cancelRequests);
  const handleClose = () => { cancelRequests(); onClose(); };

  // Criteria fingerprint to detect if filters/universe have changed since last run
  const currentFingerprint = useMemo(() => {
    const custom = customSymbols ? customSymbols.slice().sort().join(',') : '';
    return `${universe}:${custom}:${JSON.stringify(expressionTree)}`;
  }, [universe, customSymbols, expressionTree]);

  const isStale = lastRunFingerprint !== null && lastRunFingerprint !== currentFingerprint;

  // Pre-flight compatibility check
  const compatibility = useMemo(() => {
    return checkScanCompatibility(expressionTree);
  }, [expressionTree]);

  // Target sessions: anchored around currentSessionDate in contiguous chronological order
  const targetSessions = useMemo(() => {
    if (!availableSessions.length) return [];
    // Sort descending (newest to oldest)
    const sortedDesc = [...availableSessions].sort((a, b) => b.date.localeCompare(a.date));

    // Find anchor index if currentSessionDate exists in available sessions
    const anchorIdx = sortedDesc.findIndex(s => s.date === currentSessionDate);
    const startIdx = anchorIdx >= 0 ? anchorIdx : 0;

    const window = sortedDesc.slice(startIdx);
    const sliced = range === 'all' ? window : window.slice(0, range);

    // Return in chronological order (oldest to newest, left-to-right on timeline)
    return sliced.sort((a, b) => a.date.localeCompare(b.date));
  }, [availableSessions, currentSessionDate, range]);

  const summary: ScanHistorySummary = useMemo(() => {
    return computeScanHistorySummary(points, targetSessions.length);
  }, [points, targetSessions.length]);

  const handleSelectPoint = async (point: ScanHistoryPoint) => {
    symbolsControllerRef.current?.abort();
    symbolsControllerRef.current = null;
    setLoadingSymbols(false);
    setSelectedPoint(point);
    setSymbolFilter('');
    if (sessionSymbols[point.date] || point.status !== 'success' || point.count === 0) return;

    const session = targetSessions.find(s => s.date === point.date);
    if (!session) return;

    const controller = new AbortController();
    symbolsControllerRef.current = controller;
    setLoadingSymbols(true);
    try {
      const syms = await loadSessionSymbols(session, expressionTree, universe, customSymbols, controller.signal);
      if (!controller.signal.aborted) setSessionSymbols(prev => ({ ...prev, [point.date]: syms }));
    } catch (e) {
      if (!controller.signal.aborted) console.warn('Failed to load symbols on demand for session:', e);
    } finally {
      if (symbolsControllerRef.current === controller) {
        symbolsControllerRef.current = null;
        setLoadingSymbols(false);
      }
    }
  };

  const handleStartScan = async () => {
    if (!compatibility.compatible) return;

    cancelRequests();
    setLoadingSymbols(false);
    const ac = new AbortController();
    abortControllerRef.current = ac;

    setStatus('running');
    setPoints([]);
    setSelectedPoint(null);
    setProgress({ current: 0, total: targetSessions.length, pct: 0 });
    setLastRunFingerprint(currentFingerprint);

    const localPointsMap = new Map<string, ScanHistoryPoint>();

    try {
      const result = await executeScanHistory(
        targetSessions,
        expressionTree,
        universe,
        customSymbols,
        {
          concurrency: 2,
          signal: ac.signal,
          onProgress: (prog, point) => {
            localPointsMap.set(point.date, point);
            setProgress(prog);
            setPoints(targetSessions.map(s => localPointsMap.get(s.date)).filter((p): p is ScanHistoryPoint => p !== undefined));
          },
        }
      );

      if (!ac.signal.aborted) {
        setPoints(result.points);
        setStatus('completed');
        if (result.points.length > 0) {
          const lastPoint = result.points[result.points.length - 1];
          void handleSelectPoint(lastPoint);
        }
      }
    } catch (err) {
      if (!ac.signal.aborted) {
        console.error('Scan history run error:', err);
        setStatus('stopped');
      }
    }
  };

  const handleStop = () => {
    cancelRequests();
    setStatus('stopped');
  };

  const handleCopySymbols = (symbols: string[]) => {
    navigator.clipboard.writeText(symbols.join(', '));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const chartHeight = 120;
  const maxCount = useMemo(() => {
    if (!points.length) return 10;
    const max = Math.max(...points.map(p => p.count));
    return max > 0 ? max : 10;
  }, [points]);

  const currentSymbols = selectedPoint ? (sessionSymbols[selectedPoint.date] || []) : [];

  const filteredDrilldownSymbols = useMemo(() => {
    if (!selectedPoint) return [];
    if (!symbolFilter.trim()) return currentSymbols;
    const q = symbolFilter.trim().toUpperCase();
    return currentSymbols.filter(s => s.toUpperCase().includes(q));
  }, [selectedPoint, symbolFilter, currentSymbols]);

  return (
    <div className="mb-4 rounded-xl border border-line bg-surface p-4 shadow-sm text-text transition-all">
      {/* Top Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-3">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent/15 text-accent">
            <BarChart3 size={18} />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold tracking-tight">Historical Scan Frequency</h3>
              <span className="rounded-full bg-subtle px-2 py-0.5 text-[11px] font-medium text-muted-text">
                Point-in-Time Breadth
              </span>
            </div>
            <p className="text-xs text-muted-text">
              Track how many mainboard stocks passed this filter criteria across archived trading sessions.
            </p>
          </div>
        </div>

        {/* Range Selector & Action Controls */}
        <div className="flex items-center gap-2">
          <div className="flex rounded-lg border border-line bg-subtle p-0.5 text-xs font-medium">
            {([30, 60, 120, 'all'] as const).map(option => (
              <button
                key={option}
                type="button"
                onClick={() => {
                  setRange(option);
                  setStatus('idle');
                  setPoints([]);
                  setSelectedPoint(null);
                  setProgress(null);
                }}
                disabled={status === 'running'}
                className={`rounded-md px-2.5 py-1 transition-colors ${
                  range === option
                    ? 'bg-surface font-semibold text-text shadow-xs'
                    : 'text-muted-text hover:text-text'
                }`}
              >
                {option === 'all' ? `All (${targetSessions.length})` : `${option} Sessions`}
              </button>
            ))}
          </div>

          {status === 'running' ? (
            <button
              type="button"
              onClick={handleStop}
              className="flex items-center gap-1.5 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-xs font-medium text-red-500 hover:bg-red-500/20"
            >
              <Square size={13} />
              Stop
            </button>
          ) : (
            <button
              type="button"
              onClick={handleStartScan}
              disabled={!compatibility.compatible}
              className="flex items-center gap-1.5 rounded-lg bg-accent px-3.5 py-1.5 text-xs font-medium text-white hover:opacity-95 disabled:opacity-50 shadow-xs"
            >
              {points.length > 0 ? <RotateCcw size={13} /> : <Play size={13} />}
              {points.length > 0 ? 'Re-run Scan' : 'Run Scan'}
            </button>
          )}

          <button
            type="button"
            onClick={handleClose}
            aria-label="Close scan history"
            className="flex h-7 w-7 items-center justify-center rounded-lg text-muted-text hover:bg-subtle hover:text-text"
          >
            <X size={15} />
          </button>
        </div>
      </div>

      {/* Compatibility Notice if unsupported filter is present */}
      {!compatibility.compatible && (
        <div className="mt-3 flex items-start gap-2.5 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-500">
          <AlertTriangle size={15} className="mt-0.5 shrink-0" />
          <div>
            <span className="font-semibold">Filter combination unsupported for historical scanning:</span>{' '}
            {compatibility.reason}
          </div>
        </div>
      )}

      {/* Stale Warning Banner */}
      {isStale && status !== 'running' && (
        <div className="mt-3 flex items-center justify-between rounded-lg border border-line bg-subtle p-2.5 text-xs text-muted-text">
          <div className="flex items-center gap-2">
            <Info size={14} className="text-accent" />
            <span>Filters or universe have changed since this frequency scan was generated.</span>
          </div>
          <button
            type="button"
            onClick={handleStartScan}
            className="font-medium text-accent hover:underline"
          >
            Re-run to update
          </button>
        </div>
      )}

      {/* Progress Bar (Visible while running) */}
      {status === 'running' && progress && (
        <div className="mt-3">
          <div className="flex justify-between text-xs text-muted-text mb-1">
            <span>Evaluating session {progress.current} of {progress.total}...</span>
            <span>{progress.pct}%</span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-subtle">
            <div
              className="h-full bg-accent transition-all duration-150"
              style={{ width: `${progress.pct}%` }}
            />
          </div>
        </div>
      )}

      {/* Summary KPI Cards */}
      {points.length > 0 && (
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <div className="rounded-lg border border-line bg-subtle/50 p-2.5">
            <div className="flex items-center justify-between text-muted-text text-[11px]">
              <span>Avg Matches / Day</span>
              <Layers size={13} />
            </div>
            <div className="mt-1 text-base font-bold text-text">
              {summary.averageMatches}{' '}
              <span className="text-[11px] font-normal text-muted-text">stocks</span>
            </div>
          </div>

          <div className="rounded-lg border border-line bg-subtle/50 p-2.5">
            <div className="flex items-center justify-between text-muted-text text-[11px]">
              <span>Peak Hits</span>
              <TrendingUp size={13} className="text-emerald-500" />
            </div>
            <div className="mt-1 text-base font-bold text-emerald-500">
              {summary.peakCount}{' '}
              <span className="text-[11px] font-normal text-muted-text">
                ({summary.peakDate})
              </span>
            </div>
          </div>

          <div className="rounded-lg border border-line bg-subtle/50 p-2.5">
            <div className="flex items-center justify-between text-muted-text text-[11px]">
              <span>Min Hits</span>
              <Calendar size={13} />
            </div>
            <div className="mt-1 text-base font-bold text-text">
              {summary.lowestCount}{' '}
              <span className="text-[11px] font-normal text-muted-text">
                ({summary.lowestDate})
              </span>
            </div>
          </div>

          <div className="rounded-lg border border-line bg-subtle/50 p-2.5">
            <div className="flex items-center justify-between text-muted-text text-[11px]">
              <span>Hit Frequency</span>
              <Award size={13} className="text-accent" />
            </div>
            <div className="mt-1 text-base font-bold text-accent">
              {summary.frequencyPct}%{' '}
              <span className="text-[11px] font-normal text-muted-text">
                ({summary.evaluatedSessions} evaluated{summary.failedSessions > 0 ? `, ${summary.failedSessions} failed` : ''})
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Main Interactive Histogram View */}
      {points.length > 0 ? (
        <div className="mt-4">
          <div className="relative rounded-lg border border-line bg-subtle/30 p-3">
            {/* Histogram Hover Tooltip */}
            {hoveredPoint && (
              <div className="absolute top-2 right-3 z-10 rounded-md border border-line bg-surface/95 px-2.5 py-1.5 text-xs shadow-md backdrop-blur-xs">
                <div className="font-semibold text-text">
                  {hoveredPoint.date} •{' '}
                  {hoveredPoint.status === 'success' ? (
                    <span className="text-accent">{hoveredPoint.count} stocks</span>
                  ) : (
                    <span className="text-amber-500">{hoveredPoint.error || 'Evaluation error'}</span>
                  )}
                </div>
                {sessionSymbols[hoveredPoint.date] && sessionSymbols[hoveredPoint.date].length > 0 && (
                  <div className="mt-0.5 text-[11px] text-muted-text">
                    Top: {sessionSymbols[hoveredPoint.date].slice(0, 5).join(', ')}
                    {sessionSymbols[hoveredPoint.date].length > 5 ? ` (+${sessionSymbols[hoveredPoint.date].length - 5} more)` : ''}
                  </div>
                )}
              </div>
            )}

            {/* SVG Histogram */}
            <div className="w-full overflow-x-auto overflow-y-hidden pt-6 pb-1">
              <svg
                className="h-[120px] w-full min-w-[500px]"
                viewBox={`0 0 ${Math.max(500, points.length * 14)} ${chartHeight}`}
                preserveAspectRatio="none"
              >
                <line
                  x1="0"
                  y1={chartHeight / 2}
                  x2="100%"
                  y2={chartHeight / 2}
                  stroke="currentColor"
                  strokeDasharray="2 4"
                  className="text-line/40"
                />
                <line
                  x1="0"
                  y1={chartHeight - 1}
                  x2="100%"
                  y2={chartHeight - 1}
                  stroke="currentColor"
                  className="text-line"
                />

                {/* Bars */}
                {points.map((p, idx) => {
                  const totalWidth = Math.max(500, points.length * 14);
                  const barSlot = totalWidth / points.length;
                  const barWidth = Math.max(3, barSlot - 2);
                  const x = idx * barSlot + 1;
                  const isError = p.status !== 'success';
                  const barHeight = isError
                    ? 8
                    : p.count > 0
                    ? Math.max(4, (p.count / maxCount) * (chartHeight - 10))
                    : 1;
                  const y = chartHeight - barHeight;
                  const isSelected = selectedPoint?.date === p.date;
                  const isCurrentSession = currentSessionDate === p.date;

                  return (
                    <g
                      key={p.date}
                      className="cursor-pointer transition-opacity"
                      onMouseEnter={() => setHoveredPoint(p)}
                      onMouseLeave={() => setHoveredPoint(null)}
                      onClick={() => void handleSelectPoint(p)}
                    >
                      <rect
                        x={x}
                        y={y}
                        width={barWidth}
                        height={barHeight}
                        rx={barWidth > 4 ? 2 : 0}
                        className={`transition-colors ${
                          isError
                            ? 'fill-amber-500/70 hover:fill-amber-500'
                            : isSelected
                            ? 'fill-accent'
                            : isCurrentSession
                            ? 'fill-emerald-500'
                            : p.count > 0
                            ? 'fill-accent/70 hover:fill-accent'
                            : 'fill-muted-text/20 hover:fill-muted-text/40'
                        }`}
                      />
                      {isCurrentSession && (
                        <circle
                          cx={x + barWidth / 2}
                          cy={Math.max(4, y - 4)}
                          r={2}
                          className="fill-emerald-500"
                        />
                      )}
                    </g>
                  );
                })}
              </svg>

              {/* Date timeline labels */}
              <div className="flex justify-between px-1 pt-1 text-[10px] text-muted-text">
                <span>{points[0]?.date}</span>
                <span>{points[Math.floor(points.length / 2)]?.date}</span>
                <span>{points[points.length - 1]?.date}</span>
              </div>
            </div>
          </div>

          {/* Drilldown Section for Selected Session */}
          {selectedPoint && (
            <div className="mt-3 rounded-lg border border-line bg-subtle/40 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line pb-2.5">
                <div className="flex items-center gap-2">
                  <div
                    className={`flex h-6 w-6 items-center justify-center rounded-md text-xs font-bold ${
                      selectedPoint.status !== 'success'
                        ? 'bg-amber-500/15 text-amber-500'
                        : 'bg-accent/15 text-accent'
                    }`}
                  >
                    {selectedPoint.status === 'success' ? selectedPoint.count : '!'}
                  </div>
                  <div>
                    <span className="text-xs font-semibold text-text">
                      {selectedPoint.date} Session
                    </span>
                    <span className="ml-2 text-[11px] text-muted-text">
                      {selectedPoint.status !== 'success'
                        ? `Evaluation error: ${selectedPoint.error || 'Unavailable'}`
                        : selectedPoint.count === 1
                        ? '1 stock passed'
                        : `${selectedPoint.count} stocks passed`}
                    </span>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  {currentSymbols.length > 0 && (
                    <button
                      type="button"
                      onClick={() => handleCopySymbols(currentSymbols)}
                      className="flex items-center gap-1 rounded-md border border-line bg-surface px-2 py-1 text-[11px] font-medium text-text hover:bg-subtle"
                    >
                      {copied ? <Check size={12} className="text-emerald-500" /> : <Copy size={12} />}
                      {copied ? 'Copied' : 'Copy All Symbols'}
                    </button>
                  )}

                  <button
                    type="button"
                    onClick={() => onSelectSession(selectedPoint.date)}
                    className="flex items-center gap-1 rounded-md bg-accent px-2.5 py-1 text-[11px] font-medium text-white hover:opacity-95 shadow-xs"
                  >
                    <span>Load This Session</span>
                    <ChevronRight size={12} />
                  </button>
                </div>
              </div>

              {/* Symbol search within drilldown */}
              {selectedPoint.count > 8 && (
                <div className="mt-2.5 mb-2">
                  <div className="relative flex items-center">
                    <Search size={13} className="absolute left-2.5 text-muted-text" />
                    <input
                      type="text"
                      placeholder="Filter stocks on this date..."
                      value={symbolFilter}
                      onChange={e => setSymbolFilter(e.target.value)}
                      className="w-full rounded-md border border-line bg-surface py-1 pr-2.5 pl-8 text-xs text-text placeholder:text-muted-text focus:border-accent focus:outline-hidden"
                    />
                  </div>
                </div>
              )}

              {/* Stock Pills */}
              <div className="mt-2 flex flex-wrap gap-1.5 max-h-36 overflow-y-auto pr-1">
                {loadingSymbols ? (
                  <span className="text-xs text-muted-text py-2 flex items-center gap-1.5">
                    <span className="h-3 w-3 animate-spin rounded-full border border-accent border-t-transparent inline-block" />
                    Loading passing stocks for this session...
                  </span>
                ) : filteredDrilldownSymbols.length > 0 ? (
                  filteredDrilldownSymbols.map(sym => (
                    <button
                      key={sym}
                      type="button"
                      onClick={() => onSelectSession(selectedPoint.date)}
                      title={`Open session ${selectedPoint.date} with ${sym}`}
                      className="rounded-md border border-line bg-surface px-2 py-0.5 text-xs font-mono font-medium text-text hover:border-accent hover:bg-accent/10 transition-colors"
                    >
                      {sym}
                    </button>
                  ))
                ) : (
                  <span className="text-xs text-muted-text py-2">
                    {selectedPoint.status !== 'success'
                      ? `Unable to evaluate stocks on this session: ${selectedPoint.error}`
                      : selectedPoint.count === 0
                      ? 'No stocks passed this filter on this trading day.'
                      : 'No symbols match your search.'}
                  </span>
                )}
              </div>
            </div>
          )}
        </div>
      ) : status === 'idle' ? (
        <div className="my-6 flex flex-col items-center justify-center text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-subtle text-muted-text mb-2">
            <BarChart3 size={24} />
          </div>
          <h4 className="text-sm font-medium text-text">Ready to Analyze Frequency</h4>
          <p className="mt-1 max-w-sm text-xs text-muted-text">
            Test how frequently this filter triggered across {targetSessions.length} past trading sessions.
          </p>
          <button
            type="button"
            onClick={handleStartScan}
            disabled={!compatibility.compatible}
            className="mt-3 flex items-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-xs font-semibold text-white shadow-xs hover:opacity-95 disabled:opacity-50"
          >
            <Play size={14} />
            Start Scan ({targetSessions.length} Sessions)
          </button>
        </div>
      ) : null}
    </div>
  );
};
