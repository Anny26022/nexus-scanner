import React, { useState, useMemo, useRef } from 'react';
import {
  BarChart3,
  Play,
  Square,
  RotateCcw,
  Search,
  Copy,
  Check,
  ChevronRight,
  AlertTriangle,
  Info,
  X,
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
  onClose?: () => void;
}

type RangeOption = 30 | 60 | 120 | 'all';
type ViewMode = 'bars' | 'stocks';

// Comprehensive sector color palette matching Indian equity classification (Chartink style)
const SECTOR_COLORS: Record<string, string> = {
  'Financial Services': '#3b82f6',
  'Financials': '#3b82f6',
  'Bank': '#0284c7',
  'Information Technology': '#f59e0b',
  'IT': '#f59e0b',
  'i.t': '#f59e0b',
  'Healthcare': '#8b5cf6',
  'Pharma': '#8b5cf6',
  'Consumer Discretionary': '#06b6d4',
  'Consumer Goods': '#06b6d4',
  'Fast Moving Consumer Goods': '#84cc16',
  'FMCG': '#84cc16',
  'Automobile and Auto Components': '#f43f5e',
  'Automobile': '#f43f5e',
  'Auto': '#f43f5e',
  'Metals & Mining': '#10b981',
  'Metals': '#10b981',
  'Energy': '#0ea5e9',
  'Oil & Gas': '#0ea5e9',
  'Power': '#14b8a6',
  'Power & Utilities': '#14b8a6',
  'Utilities': '#14b8a6',
  'Chemicals': '#a3e635',
  'Capital Goods': '#d946ef',
  'Industrials': '#d946ef',
  'Construction': '#22c55e',
  'Construction Materials': '#2dd4bf',
  'Building Materials': '#2dd4bf',
  'Telecommunication': '#fb923c',
  'Telecom': '#fb923c',
  'Services': '#6366f1',
  'Media': '#10b981',
  'Realty': '#a855f7',
  'Real Estate': '#a855f7',
  'Textiles': '#059669',
  'Transportation': '#e11d48',
  'Others': '#94a3b8',
  'Unclassified': '#94a3b8',
};

function getSectorColor(sector: string): string {
  if (SECTOR_COLORS[sector]) return SECTOR_COLORS[sector];
  const colors = [
    '#3b82f6', '#ec4899', '#f59e0b', '#10b981', '#8b5cf6',
    '#06b6d4', '#84cc16', '#f43f5e', '#d946ef', '#14b8a6',
    '#eab308', '#0ea5e9', '#a855f7', '#fb923c', '#2dd4bf',
  ];
  let hash = 0;
  for (let i = 0; i < sector.length; i++) {
    hash = (hash << 5) - hash + sector.charCodeAt(i);
  }
  return colors[Math.abs(hash) % colors.length];
}

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
  expressionTree,
  universe,
  customSymbols,
  availableSessions,
  currentSessionDate,
  onSelectSession,
  onClose,
}) => {
  const [range, setRange] = useState<RangeOption>(60);
  const [viewMode, setViewMode] = useState<ViewMode>('bars');
  const [status, setStatus] = useState<'idle' | 'running' | 'completed' | 'stopped'>('idle');
  const [points, setPoints] = useState<ScanHistoryPoint[]>([]);
  const [lastRunFingerprint, setLastRunFingerprint] = useState<string | null>(null);
  const [progress, setProgress] = useState<ScanHistoryProgress | null>(null);
  const [hoveredPoint, setHoveredPoint] = useState<ScanHistoryPoint | null>(null);
  const [selectedPointState, setSelectedPointState] = useState<ScanHistoryPoint | null>(null);
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

  const handleClose = () => {
    cancelRequests();
    onClose?.();
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

  // Derived selected point (defaults to latest evaluated point if none explicitly selected)
  const selectedPoint = useMemo(() => {
    if (selectedPointState) return selectedPointState;
    return points.length > 0 ? points[points.length - 1] : null;
  }, [selectedPointState, points]);

  const handleSelectPoint = async (point: ScanHistoryPoint) => {
    setSelectedPointState(point);
    setSymbolFilter('');
    if (sessionSymbols[point.date] || point.status !== 'success' || point.count === 0) return;

    const session = targetSessions.find(s => s.date === point.date);
    if (!session) return;

    symbolsControllerRef.current?.abort();
    const sc = new AbortController();
    symbolsControllerRef.current = sc;

    setLoadingSymbols(true);
    try {
      const syms = await loadSessionSymbols(session, expressionTree, universe, customSymbols);
      if (!sc.signal.aborted) {
        setSessionSymbols(prev => ({ ...prev, [point.date]: syms }));
      }
    } catch (e) {
      if (!sc.signal.aborted) {
        console.warn('Failed to load symbols on demand for session:', e);
      }
    } finally {
      if (!sc.signal.aborted) {
        setLoadingSymbols(false);
      }
    }
  };

  const handleStartScan = async () => {
    if (!compatibility.compatible) return;

    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    const ac = new AbortController();
    abortControllerRef.current = ac;

    setStatus('running');
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

  // Aggregate active sectors across evaluated sessions
  const activeSectors = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const p of points) {
      if (p.sectorCounts) {
        for (const [sec, count] of Object.entries(p.sectorCounts)) {
          counts[sec] = (counts[sec] || 0) + count;
        }
      }
    }
    return Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .map(([sec]) => sec);
  }, [points]);

  const chartHeight = 160;
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
    <section
      aria-label="Backtest History"
      className="mt-6 rounded-2xl border border-line bg-surface p-4 sm:p-5 shadow-xs text-text transition-all"
    >
      {/* Section Top Header (Chartink-Style) */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-4">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-bold uppercase tracking-wider text-text">
              BACKTEST HISTORY
            </h2>
            <span className="rounded-full bg-subtle px-2.5 py-0.5 text-xs font-medium text-muted">
              {range === 'all' ? `All (${targetSessions.length} sessions)` : `${range} sessions`}
            </span>
          </div>
          {status === 'completed' && points.length > 0 && (
            <div className="hidden sm:flex items-center gap-3 pl-3 border-l border-line text-xs text-muted">
              <span>Avg: <strong className="text-text tabular-nums">{summary.averageMatches}</strong> stocks/day</span>
              <span>Peak: <strong className="text-positive tabular-nums">{summary.peakCount}</strong></span>
              <span>Hit Rate: <strong className="text-accent tabular-nums">{summary.frequencyPct}%</strong></span>
            </div>
          )}
        </div>

        {/* Top Controls: View Switch, Range, Action */}
        <div className="flex flex-wrap items-center gap-2.5">
          {/* Chartink [Bars / Stocks] Switch */}
          <div className="flex rounded-lg border border-line bg-subtle p-0.5 text-xs font-medium">
            <button
              type="button"
              onClick={() => setViewMode('bars')}
              className={`rounded-md px-3 py-1 transition-all ${
                viewMode === 'bars'
                  ? 'bg-surface font-semibold text-text shadow-xs'
                  : 'text-muted hover:text-text'
              }`}
            >
              Bars
            </button>
            <button
              type="button"
              onClick={() => setViewMode('stocks')}
              className={`rounded-md px-3 py-1 transition-all ${
                viewMode === 'stocks'
                  ? 'bg-surface font-semibold text-text shadow-xs'
                  : 'text-muted hover:text-text'
              }`}
            >
              Stocks
            </button>
          </div>

          {/* Time Range Selector */}
          <div className="flex rounded-lg border border-line bg-subtle p-0.5 text-xs font-medium">
            {([30, 60, 120, 'all'] as const).map(option => (
              <button
                key={option}
                type="button"
                onClick={() => {
                  setRange(option);
                  setStatus('idle');
                }}
                disabled={status === 'running'}
                className={`rounded-md px-2.5 py-1 transition-all ${
                  range === option
                    ? 'bg-surface font-semibold text-text shadow-xs'
                    : 'text-muted hover:text-text'
                }`}
              >
                {option === 'all' ? 'All' : `${option}d`}
              </button>
            ))}
          </div>

          {/* Run / Stop Button */}
          {status === 'running' ? (
            <button
              type="button"
              onClick={handleStop}
              className="button button-secondary text-negative hover:bg-negative/10 hover:border-negative-line text-xs h-7 px-3"
            >
              <Square size={12} />
              <span>Stop</span>
            </button>
          ) : (
            <button
              type="button"
              onClick={handleStartScan}
              disabled={!compatibility.compatible}
              className="button button-primary text-xs h-7 px-3"
            >
              {points.length > 0 ? <RotateCcw size={12} /> : <Play size={12} />}
              <span>{points.length > 0 ? 'Re-run Scan' : 'Run Scan'}</span>
            </button>
          )}

          {onClose && (
            <button
              type="button"
              onClick={handleClose}
              aria-label="Close dialog"
              className="rounded-lg p-1 text-muted hover:bg-subtle hover:text-text transition-colors"
              title="Close Backtest"
            >
              <X size={16} />
            </button>
          )}
        </div>
      </div>

      {/* Info / Notice Strip (Chartink style) */}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
        <div className="flex items-center gap-1.5">
          <Info size={13} className="text-muted shrink-0" />
          <span>Click on bars to view stock details filtered at the given time</span>
        </div>
        {selectedPoint && (
          <span className="font-medium text-text">
            Selected: <strong className="text-accent">{selectedPoint.date}</strong> ({selectedPoint.count} stocks)
          </span>
        )}
      </div>

      {/* Compatibility Warning if filter is unsupported */}
      {!compatibility.compatible && (
        <div className="mt-3 flex items-start gap-2.5 rounded-xl border border-warning/30 bg-warning/10 p-3 text-xs text-warning">
          <AlertTriangle size={15} className="mt-0.5 shrink-0" />
          <div>
            <span className="font-semibold">Filter combination unsupported for historical scanning:</span>{' '}
            {compatibility.reason}
          </div>
        </div>
      )}

      {/* Stale Warning Banner */}
      {isStale && status !== 'running' && (
        <div className="mt-3 flex items-center justify-between rounded-xl border border-line bg-subtle/50 px-3 py-2 text-xs text-muted">
          <div className="flex items-center gap-2">
            <Info size={14} className="text-accent" />
            <span>Criteria have changed since this backtest was generated.</span>
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

      {/* In-flight Progress Bar */}
      {status === 'running' && progress && (
        <div className="mt-3 rounded-xl border border-line bg-subtle/30 p-3">
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

      {/* Chartink Stacked Sector Legend (Visible in Bars View) */}
      {viewMode === 'bars' && activeSectors.length > 0 && (
        <div className="mt-4 flex flex-wrap items-center gap-1.5 max-h-24 overflow-y-auto pr-1">
          {activeSectors.map(sector => (
            <span
              key={sector}
              className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[11px] font-medium bg-subtle/80 border border-line/60 text-secondary"
            >
              <span
                className="w-2.5 h-2.5 rounded-xs shrink-0"
                style={{ backgroundColor: getSectorColor(sector) }}
              />
              <span className="truncate max-w-[140px]">{sector}</span>
            </span>
          ))}
        </div>
      )}

      {/* Main Backtest Visualizations */}
      {points.length > 0 ? (
        <div className="mt-4">
          {viewMode === 'bars' ? (
            /* BARS VIEW: Chartink-Style Stacked Histogram */
            <div className="relative rounded-xl border border-line bg-surface p-4 shadow-xs">
              {/* Floating Tooltip */}
              {hoveredPoint && (
                <div className="absolute top-3 right-4 z-10 rounded-lg border border-line bg-surface/95 px-3 py-2 text-xs shadow-md backdrop-blur-xs max-w-xs">
                  <div className="font-semibold text-text flex items-center justify-between gap-2">
                    <span>{formatDisplayDate(hoveredPoint.date)}</span>
                    <span className="text-accent font-bold tabular-nums">{hoveredPoint.count} stocks</span>
                  </div>
                  {hoveredPoint.sectorCounts && Object.keys(hoveredPoint.sectorCounts).length > 0 && (
                    <div className="mt-1.5 space-y-0.5 border-t border-line/60 pt-1 text-[11px] text-muted max-h-28 overflow-y-auto pr-1">
                      {Object.entries(hoveredPoint.sectorCounts)
                        .sort((a, b) => b[1] - a[1])
                        .slice(0, 5)
                        .map(([sec, count]) => (
                          <div key={sec} className="flex items-center justify-between gap-2">
                            <span className="flex items-center gap-1.5 truncate">
                              <span
                                className="w-2 h-2 rounded-full shrink-0"
                                style={{ backgroundColor: getSectorColor(sec) }}
                              />
                              <span className="truncate">{sec}</span>
                            </span>
                            <span className="tabular-nums font-mono text-text">{count}</span>
                          </div>
                        ))}
                    </div>
                  )}
                </div>
              )}

              {/* Stacked SVG Chart */}
              <div className="w-full overflow-x-auto overflow-y-hidden pt-2 pb-1">
                <svg
                  className="h-[160px] w-full min-w-[560px]"
                  viewBox={`0 0 ${Math.max(560, points.length * 16)} ${chartHeight}`}
                  preserveAspectRatio="none"
                >
                  {/* Gridlines */}
                  {[0.25, 0.5, 0.75].map(ratio => (
                    <line
                      key={ratio}
                      x1="0"
                      y1={chartHeight * ratio}
                      x2="100%"
                      y2={chartHeight * ratio}
                      stroke="currentColor"
                      strokeDasharray="2 4"
                      className="text-line/40"
                    />
                  ))}
                  {/* Baseline */}
                  <line
                    x1="0"
                    y1={chartHeight - 1}
                    x2="100%"
                    y2={chartHeight - 1}
                    stroke="currentColor"
                    className="text-line"
                  />

                  {/* Stacked Bars per Session */}
                  {points.map((p, idx) => {
                    const totalWidth = Math.max(560, points.length * 16);
                    const barSlot = totalWidth / points.length;
                    const barWidth = Math.max(3, barSlot - 2);
                    const x = idx * barSlot + 1;
                    const isSelected = selectedPoint?.date === p.date;
                    const isCurrentSession = currentSessionDate === p.date;
                    const isError = p.status !== 'success';

                    if (isError) {
                      return (
                        <g key={p.date} className="cursor-pointer" onClick={() => void handleSelectPoint(p)}>
                          <rect
                            x={x}
                            y={chartHeight - 8}
                            width={barWidth}
                            height={8}
                            rx={1}
                            className="fill-warning/70 hover:fill-warning"
                          />
                        </g>
                      );
                    }

                    if (p.count === 0) {
                      return (
                        <g key={p.date} className="cursor-pointer" onClick={() => void handleSelectPoint(p)}>
                          <rect
                            x={x}
                            y={chartHeight - 2}
                            width={barWidth}
                            height={2}
                            className="fill-muted/20 hover:fill-muted/40"
                          />
                        </g>
                      );
                    }

                    // Stack segments by sector
                    const sectorEntries: [string, number][] =
                      p.sectorCounts && Object.keys(p.sectorCounts).length > 0
                        ? Object.entries(p.sectorCounts)
                        : [['Others', p.count]];

                    const totalBarHeight = Math.max(4, (p.count / maxCount) * (chartHeight - 20));
                    let currentY = chartHeight;

                    return (
                      <g
                        key={p.date}
                        className="cursor-pointer transition-opacity"
                        onMouseEnter={() => setHoveredPoint(p)}
                        onMouseLeave={() => setHoveredPoint(null)}
                        onClick={() => void handleSelectPoint(p)}
                      >
                        {/* Background hit highlight if selected */}
                        {isSelected && (
                          <rect
                            x={x - 1}
                            y={chartHeight - totalBarHeight - 4}
                            width={barWidth + 2}
                            height={totalBarHeight + 4}
                            rx={3}
                            className="fill-accent/15 stroke-accent stroke-[1.5]"
                          />
                        )}

                        {sectorEntries.map(([sec, count], segIdx) => {
                          const segHeight = Math.max(1, (count / p.count) * totalBarHeight);
                          currentY -= segHeight;
                          const isTop = segIdx === sectorEntries.length - 1;
                          return (
                            <rect
                              key={sec}
                              x={x}
                              y={currentY}
                              width={barWidth}
                              height={segHeight}
                              rx={isTop && barWidth > 3 ? 2 : 0}
                              fill={getSectorColor(sec)}
                              className="opacity-90 hover:opacity-100 transition-opacity"
                            />
                          );
                        })}

                        {/* Anchor dot for current live session */}
                        {isCurrentSession && (
                          <circle
                            cx={x + barWidth / 2}
                            cy={Math.max(4, chartHeight - totalBarHeight - 5)}
                            r={2.5}
                            className="fill-positive"
                          />
                        )}
                      </g>
                    );
                  })}
                </svg>

                {/* Timeline Date Milestones */}
                <div className="flex justify-between px-1 pt-2 text-[10px] text-muted font-mono">
                  <span>{formatDisplayDate(points[0]?.date)}</span>
                  <span>{formatDisplayDate(points[Math.floor(points.length * 0.25)]?.date)}</span>
                  <span>{formatDisplayDate(points[Math.floor(points.length * 0.5)]?.date)}</span>
                  <span>{formatDisplayDate(points[Math.floor(points.length * 0.75)]?.date)}</span>
                  <span>{formatDisplayDate(points[points.length - 1]?.date)}</span>
                </div>
              </div>
            </div>
          ) : null}

          {/* STOCKS VIEW OR DRILLDOWN INSPECTOR */}
          {(viewMode === 'stocks' || selectedPoint) && (
            <div className="mt-4 rounded-xl border border-line bg-surface p-4 shadow-xs">
              {/* Session Drilldown Header */}
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-3">
                <div className="flex items-center gap-2.5">
                  <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent-soft text-accent border border-accent-line text-xs font-bold tabular-nums">
                    {selectedPoint?.count ?? 0}
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-bold text-text">
                        Session {selectedPoint?.date}
                      </span>
                      <span className="text-[11px] text-muted">
                        ({formatDisplayDate(selectedPoint?.date || '')})
                      </span>
                    </div>
                    <p className="text-[11px] text-muted">
                      {selectedPoint?.status !== 'success'
                        ? `Evaluation error: ${selectedPoint?.error || 'Unavailable'}`
                        : selectedPoint?.count === 1
                        ? '1 stock matched criteria'
                        : `${selectedPoint?.count ?? 0} stocks matched criteria on this date`}
                    </p>
                  </div>
                </div>

                {/* Search & Actions */}
                <div className="flex items-center gap-2">
                  {(selectedPoint?.count ?? 0) > 6 && (
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

                  {selectedPoint && (
                    <button
                      type="button"
                      onClick={() => {
                        onSelectSession(selectedPoint.date);
                        window.scrollTo({ top: 0, behavior: 'smooth' });
                      }}
                      className="button button-primary text-xs h-7 px-2.5"
                    >
                      <span>Load This Session</span>
                      <ChevronRight size={12} />
                    </button>
                  )}
                </div>
              </div>

              {/* Passing Symbols Grid */}
              <div className="mt-3">
                {loadingSymbols ? (
                  <div className="flex items-center justify-center gap-2 py-6 text-xs text-muted">
                    <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-accent border-t-transparent" />
                    <span>Loading passing stocks for this session...</span>
                  </div>
                ) : filteredDrilldownSymbols.length > 0 ? (
                  <div>
                    <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-1.5 max-h-56 overflow-y-auto pr-1">
                      {filteredDrilldownSymbols.map(sym => (
                        <button
                          key={sym}
                          type="button"
                          onClick={() => {
                            onSelectSession(selectedPoint!.date);
                            window.scrollTo({ top: 0, behavior: 'smooth' });
                          }}
                          title={`Load session ${selectedPoint?.date} with ${sym}`}
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
                    {selectedPoint?.status !== 'success'
                      ? `Unable to evaluate stocks on this session: ${selectedPoint?.error}`
                      : selectedPoint?.count === 0
                      ? 'No stocks passed this filter criteria on this trading day.'
                      : `No symbols match "${symbolFilter}".`}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      ) : status === 'idle' ? (
        /* Empty / Idle State */
        <div className="my-8 flex flex-col items-center justify-center text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent-soft text-accent border border-accent-line mb-3">
            <BarChart3 size={24} />
          </div>
          <h3 className="text-sm font-semibold text-text">Ready to Backtest Frequency & Sector Breadth</h3>
          <p className="mt-1 max-w-md text-xs text-muted">
            Analyze historical match frequency and stacked sector breakdown across {targetSessions.length} archived sessions exact like Chartink.
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
    </section>
  );
};
