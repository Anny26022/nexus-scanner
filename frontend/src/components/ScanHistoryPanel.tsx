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
import { Dialog } from './Dialog';
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
  isOpen?: boolean;
  expressionTree: ExpressionNode;
  universe: UniverseType;
  customSymbols?: string[];
  availableSessions: ScanSession[];
  currentSessionDate: string;
  onSelectSession: (date: string) => void;
  onClose: () => void;
}

type RangeOption = 30 | 60 | 120 | 'all';

function formatDisplayDate(dateStr: string): string {
  if (!dateStr) return '';
  try {
    const d = new Date(`${dateStr}T00:00:00`);
    return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: '2-digit' });
  } catch {
    return dateStr;
  }
}

export const ScanHistoryPanel: React.FC<ScanHistoryPanelProps> = ({
  isOpen = true,
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

  useMountEffect(() => () => {
    abortControllerRef.current?.abort();
    symbolsControllerRef.current?.abort();
    abortControllerRef.current = null;
    symbolsControllerRef.current = null;
  });

  const handleClose = () => {
    abortControllerRef.current?.abort();
    symbolsControllerRef.current?.abort();
    abortControllerRef.current = null;
    symbolsControllerRef.current = null;
    onClose();
  };

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
    const sortedDesc = [...availableSessions].sort((a, b) => b.date.localeCompare(a.date));
    const anchorIdx = sortedDesc.findIndex(s => s.date === currentSessionDate);
    const startIdx = anchorIdx >= 0 ? anchorIdx : 0;
    const window = sortedDesc.slice(startIdx);
    const sliced = range === 'all' ? window : window.slice(0, range);
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

    symbolsControllerRef.current?.abort();
    symbolsControllerRef.current = null;
    setLoadingSymbols(false);
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
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
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    setStatus('stopped');
  };

  const handleCopySymbols = (symbols: string[]) => {
    navigator.clipboard.writeText(symbols.join(', '));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const chartHeight = 130;
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

  if (!isOpen) return null;

  return (
    <Dialog label="Historical Scan Frequency" onClose={handleClose} className="scan-history-dialog">
      {/* Dialog Header */}
      <div className="dialog-header">
        <div className="flex items-center gap-3 min-w-0">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent border border-accent-line">
            <BarChart3 size={18} />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="text-base font-semibold tracking-tight text-text truncate">
                Historical Scan Frequency
              </h2>
              <span className="hidden sm:inline-flex rounded-full bg-accent-soft px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-accent border border-accent-line">
                Point-in-Time Breadth
              </span>
            </div>
            <p className="text-xs text-muted truncate mt-0.5">
              Analyze filter trigger frequency and passing stocks across archived trading sessions.
            </p>
          </div>
        </div>

        {/* Action Controls & Close */}
        <div className="scan-history-actions flex items-center gap-2 shrink-0">
          {/* Range Selector */}
          <div className="scan-history-range flex rounded-lg border border-line bg-subtle p-0.5 text-xs font-medium">
            {([30, 60, 120, 'all'] as const).map(option => (
              <button
                key={option}
                type="button"
                aria-label={option === 'all' ? `All ${targetSessions.length} trading sessions` : `${option} trading sessions`}
                onClick={() => {
                  setRange(option);
                  setStatus('idle');
                  setPoints([]);
                  setSelectedPoint(null);
                  setProgress(null);
                }}
                disabled={status === 'running'}
                className={`rounded-md px-2.5 py-1 transition-all ${
                  range === option
                    ? 'bg-surface font-semibold text-text shadow-xs'
                    : 'text-muted hover:text-text'
                }`}
              >
                {option === 'all' ? `All (${targetSessions.length})` : <>{option}<span className="hidden sm:inline"> sessions</span></>}
              </button>
            ))}
          </div>

          {/* Run / Stop Button */}
          {status === 'running' ? (
            <button
              type="button"
              onClick={handleStop}
              className="button button-secondary text-negative hover:bg-negative/10 hover:border-negative-line"
            >
              <Square size={12} />
              <span>Stop</span>
            </button>
          ) : (
            <button
              type="button"
              onClick={handleStartScan}
              disabled={!compatibility.compatible}
              className="button button-primary"
            >
              {points.length > 0 ? <RotateCcw size={13} /> : <Play size={13} />}
              <span>{points.length > 0 ? 'Re-run Scan' : 'Run Scan'}</span>
            </button>
          )}

          <button
            type="button"
            onClick={handleClose}
            aria-label="Close dialog"
            className="flex h-8 w-8 items-center justify-center rounded-lg text-muted hover:bg-surface-hover hover:text-text transition-colors"
          >
            <X size={16} />
          </button>
        </div>
      </div>

      {/* Dialog Body Content */}
      <div className="dialog-content">
        {/* Compatibility Notice */}
        {!compatibility.compatible && (
          <div className="flex items-start gap-2.5 rounded-xl border border-warning/30 bg-warning/10 p-3 text-xs text-warning">
            <AlertTriangle size={15} className="mt-0.5 shrink-0" />
            <div>
              <span className="font-semibold">Filter combination unsupported for historical scanning:</span>{' '}
              {compatibility.reason}
            </div>
          </div>
        )}

        {/* Stale Warning Banner */}
        {isStale && status !== 'running' && (
          <div className="flex items-center justify-between rounded-xl border border-line bg-subtle/50 px-3 py-2 text-xs text-muted">
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

        {/* Scanning Progress Bar */}
        {status === 'running' && progress && (
          <div className="rounded-xl border border-line bg-subtle/30 p-3">
            <div className="flex justify-between text-xs text-muted mb-1.5 font-medium">
              <span>Evaluating session {progress.current} of {progress.total}...</span>
              <span className="font-mono text-accent font-semibold">{progress.pct}%</span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-subtle">
              <div
                className="h-full bg-accent transition-all duration-150 rounded-full"
                style={{ width: `${progress.pct}%` }}
              />
            </div>
          </div>
        )}

        {/* Main Content Area */}
        {points.length > 0 ? (
          <div className="flex flex-col gap-4">
            {/* KPI Summary Cards */}
            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
              <div className="rounded-xl border border-line bg-surface p-3 transition-colors shadow-xs">
                <div className="flex items-center justify-between text-muted text-[11px] font-medium uppercase tracking-wider">
                  <span>Avg Matches / Day</span>
                  <Layers size={13} className="text-muted" />
                </div>
                <div className="mt-1.5 text-xl font-bold tracking-tight text-text tabular-nums">
                  {summary.averageMatches}{' '}
                  <span className="text-xs font-normal text-muted">stocks</span>
                </div>
              </div>

              <div className="rounded-xl border border-line bg-surface p-3 transition-colors shadow-xs">
                <div className="flex items-center justify-between text-muted text-[11px] font-medium uppercase tracking-wider">
                  <span>Peak Hits</span>
                  <TrendingUp size={13} className="text-positive" />
                </div>
                <div className="mt-1.5 text-xl font-bold tracking-tight text-positive tabular-nums">
                  {summary.peakCount}{' '}
                  <span className="text-[11px] font-normal text-muted">
                    ({formatDisplayDate(summary.peakDate)})
                  </span>
                </div>
              </div>

              <div className="rounded-xl border border-line bg-surface p-3 transition-colors shadow-xs">
                <div className="flex items-center justify-between text-muted text-[11px] font-medium uppercase tracking-wider">
                  <span>Min Hits</span>
                  <Calendar size={13} className="text-muted" />
                </div>
                <div className="mt-1.5 text-xl font-bold tracking-tight text-text tabular-nums">
                  {summary.lowestCount}{' '}
                  <span className="text-[11px] font-normal text-muted">
                    ({formatDisplayDate(summary.lowestDate)})
                  </span>
                </div>
              </div>

              <div className="rounded-xl border border-line bg-surface p-3 transition-colors shadow-xs">
                <div className="flex items-center justify-between text-muted text-[11px] font-medium uppercase tracking-wider">
                  <span>Hit Frequency</span>
                  <Award size={13} className="text-accent" />
                </div>
                <div className="mt-1.5 text-xl font-bold tracking-tight text-accent tabular-nums">
                  {summary.frequencyPct}%{' '}
                  <span className="text-[11px] font-normal text-muted">
                    ({summary.evaluatedSessions} evaluated{summary.failedSessions > 0 ? `, ${summary.failedSessions} failed` : ''})
                  </span>
                </div>
              </div>
            </div>

            {/* Interactive Histogram Chart */}
            <div className="relative rounded-xl border border-line bg-surface p-4 shadow-xs">
              <div className="flex items-center justify-between text-xs text-muted mb-2">
                <span className="font-medium text-text">Historical Matches Distribution</span>
                {hoveredPoint ? (
                  <span className="font-medium text-text bg-subtle px-2 py-0.5 rounded-md border border-line">
                    <strong className="text-accent">{hoveredPoint.count}</strong> stocks on{' '}
                    {formatDisplayDate(hoveredPoint.date)}
                  </span>
                ) : (
                  <span className="text-[11px]">Hover over bars to inspect • Click to view passing stocks</span>
                )}
              </div>

              {/* SVG Histogram */}
              <div className="w-full overflow-x-auto overflow-y-hidden pt-2 pb-1">
                <svg
                  className="h-[130px] w-full min-w-[540px]"
                  viewBox={`0 0 ${Math.max(540, points.length * 15)} ${chartHeight}`}
                  preserveAspectRatio="none"
                >
                  {/* Midline Guide */}
                  <line
                    x1="0"
                    y1={chartHeight / 2}
                    x2="100%"
                    y2={chartHeight / 2}
                    stroke="currentColor"
                    strokeDasharray="2 4"
                    className="text-line/40"
                  />
                  {/* Base Line */}
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
                    const totalWidth = Math.max(540, points.length * 15);
                    const barSlot = totalWidth / points.length;
                    const barWidth = Math.max(3, barSlot - 2);
                    const x = idx * barSlot + 1;
                    const isError = p.status !== 'success';
                    const barHeight = isError
                      ? 8
                      : p.count > 0
                      ? Math.max(4, (p.count / maxCount) * (chartHeight - 16))
                      : 1.5;
                    const y = chartHeight - barHeight;
                    const isSelected = selectedPoint?.date === p.date;
                    const isCurrentSession = currentSessionDate === p.date;

                    return (
                      <g
                        key={p.date}
                        className="cursor-pointer"
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
                          className={`transition-colors duration-100 ${
                            isError
                              ? 'fill-warning/70 hover:fill-warning'
                              : isSelected
                              ? 'fill-accent'
                              : isCurrentSession
                              ? 'fill-positive'
                              : p.count > 0
                              ? 'fill-accent/70 hover:fill-accent'
                              : 'fill-muted/20 hover:fill-muted/40'
                          }`}
                        />
                        {isCurrentSession && (
                          <circle
                            cx={x + barWidth / 2}
                            cy={Math.max(4, y - 4)}
                            r={2.5}
                            className="fill-positive"
                          />
                        )}
                      </g>
                    );
                  })}
                </svg>

                {/* Timeline Labels */}
                <div className="flex justify-between px-1 pt-1.5 text-[10px] text-muted font-mono">
                  <span>{formatDisplayDate(points[0]?.date)}</span>
                  <span>{formatDisplayDate(points[Math.floor(points.length * 0.25)]?.date)}</span>
                  <span>{formatDisplayDate(points[Math.floor(points.length * 0.5)]?.date)}</span>
                  <span>{formatDisplayDate(points[Math.floor(points.length * 0.75)]?.date)}</span>
                  <span>{formatDisplayDate(points[points.length - 1]?.date)}</span>
                </div>
              </div>
            </div>

            {/* Drilldown Section for Selected Session */}
            {selectedPoint && (
              <div className="rounded-xl border border-line bg-surface p-4 shadow-xs">
                {/* Drilldown Header */}
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-3">
                  <div className="flex items-center gap-2.5">
                    <div
                      className={`flex h-7 w-7 items-center justify-center rounded-lg text-xs font-bold ${
                        selectedPoint.status !== 'success'
                          ? 'bg-warning/15 text-warning'
                          : 'bg-accent-soft text-accent border border-accent-line'
                      }`}
                    >
                      {selectedPoint.status === 'success' ? selectedPoint.count : '!'}
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-semibold text-text">
                          Session {selectedPoint.date}
                        </span>
                        <span className="text-[11px] text-muted">
                          ({formatDisplayDate(selectedPoint.date)})
                        </span>
                      </div>
                      <p className="text-[11px] text-muted">
                        {selectedPoint.status !== 'success'
                          ? `Evaluation error: ${selectedPoint.error || 'Unavailable'}`
                          : selectedPoint.count === 1
                          ? '1 stock matched your criteria'
                          : `${selectedPoint.count} stocks matched your criteria`}
                      </p>
                    </div>
                  </div>

                  {/* Actions & Symbol Search */}
                  <div className="flex items-center gap-2">
                    {selectedPoint.count > 6 && (
                      <div className="relative flex items-center">
                        <Search size={12} className="absolute left-2.5 text-muted pointer-events-none" />
                        <input
                          type="text"
                          placeholder="Filter symbols..."
                          value={symbolFilter}
                          onChange={e => setSymbolFilter(e.target.value)}
                          className="h-7 w-36 rounded-md border border-line bg-surface-subtle py-0.5 pr-2 pl-7 text-xs text-text placeholder:text-muted focus:border-accent focus:bg-surface focus:outline-hidden transition-all"
                        />
                      </div>
                    )}

                    {currentSymbols.length > 0 && (
                      <button
                        type="button"
                        onClick={() => handleCopySymbols(currentSymbols)}
                        className="button button-secondary text-xs h-7 px-2.5"
                      >
                        {copied ? <Check size={12} className="text-positive" /> : <Copy size={12} />}
                        <span>{copied ? 'Copied' : 'Copy All'}</span>
                      </button>
                    )}

                    <button
                      type="button"
                      onClick={() => {
                        onSelectSession(selectedPoint.date);
                        handleClose();
                      }}
                      className="button button-primary text-xs h-7 px-2.5"
                    >
                      <span>Load This Session</span>
                      <ChevronRight size={12} />
                    </button>
                  </div>
                </div>

                {/* Symbols Grid */}
                <div className="mt-3">
                  {loadingSymbols ? (
                    <div className="flex items-center justify-center gap-2 py-6 text-xs text-muted">
                      <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-accent border-t-transparent" />
                      <span>Loading passing stocks for this session...</span>
                    </div>
                  ) : filteredDrilldownSymbols.length > 0 ? (
                    <div>
                      <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-1.5 max-h-48 overflow-y-auto pr-1">
                        {filteredDrilldownSymbols.map(sym => (
                          <button
                            key={sym}
                            type="button"
                            onClick={() => {
                              onSelectSession(selectedPoint.date);
                              handleClose();
                            }}
                            title={`Load session ${selectedPoint.date} to inspect ${sym}`}
                            className="rounded-md border border-line bg-surface-subtle hover:bg-surface hover:border-accent hover:text-accent px-2 py-1 text-xs font-mono font-medium text-text transition-all text-center truncate"
                          >
                            {sym}
                          </button>
                        ))}
                      </div>
                      <div className="mt-2 text-[11px] text-muted text-right">
                        Showing {filteredDrilldownSymbols.length} of {currentSymbols.length} stocks
                      </div>
                    </div>
                  ) : (
                    <div className="py-6 text-center text-xs text-muted">
                      {selectedPoint.status !== 'success'
                        ? `Unable to evaluate stocks on this session: ${selectedPoint.error}`
                        : selectedPoint.count === 0
                        ? 'No stocks passed this filter criteria on this trading day.'
                        : `No symbols match "${symbolFilter}".`}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        ) : status === 'idle' ? (
          <div className="my-8 flex flex-col items-center justify-center text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent-soft text-accent border border-accent-line mb-3">
              <BarChart3 size={24} />
            </div>
            <h3 className="text-sm font-semibold text-text">Ready to Analyze Frequency</h3>
            <p className="mt-1 max-w-md text-xs text-muted">
              Evaluate this filter criteria across {targetSessions.length} archived trading sessions to test historical consistency, breadth, and market hit rate.
            </p>
            <button
              type="button"
              onClick={handleStartScan}
              disabled={!compatibility.compatible}
              className="mt-4 button button-primary px-4 py-2 text-xs"
            >
              <Play size={13} />
              <span>Start Frequency Scan ({targetSessions.length} Sessions)</span>
            </button>
          </div>
        ) : null}
      </div>
    </Dialog>
  );
};

