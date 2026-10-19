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
} from 'lucide-react';
import type { ExpressionNode, UniverseType } from '../types/screener';
import {
  executeScanHistory,
  computeScanHistorySummary,
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
  const [progress, setProgress] = useState<ScanHistoryProgress | null>(null);
  const [hoveredPoint, setHoveredPoint] = useState<ScanHistoryPoint | null>(null);
  const [selectedPoint, setSelectedPoint] = useState<ScanHistoryPoint | null>(null);
  const [symbolFilter, setSymbolFilter] = useState('');
  const [copied, setCopied] = useState(false);

  const abortControllerRef = useRef<AbortController | null>(null);

  // Target sessions in chronological order (oldest to newest)
  const targetSessions = useMemo(() => {
    if (!availableSessions.length) return [];
    // Sort descending first to take most recent N, then reverse for chronological left-to-right timeline
    const sortedDesc = [...availableSessions].sort((a, b) => b.date.localeCompare(a.date));
    const sliced = range === 'all' ? sortedDesc : sortedDesc.slice(0, range);
    return sliced.sort((a, b) => a.date.localeCompare(b.date));
  }, [availableSessions, range]);

  const summary: ScanHistorySummary = useMemo(() => {
    return computeScanHistorySummary(points, targetSessions.length);
  }, [points, targetSessions.length]);

  const handleStartScan = async () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    const ac = new AbortController();
    abortControllerRef.current = ac;

    setStatus('running');
    setProgress({ current: 0, total: targetSessions.length, pct: 0 });

    const localPointsMap = new Map<string, ScanHistoryPoint>();

    try {
      const result = await executeScanHistory(
        targetSessions,
        expressionTree,
        universe,
        customSymbols,
        {
          concurrency: 4,
          signal: ac.signal,
          onProgress: (prog, point) => {
            localPointsMap.set(point.date, point);
            setProgress(prog);
            // Real-time chart rendering as points stream in
            setPoints(targetSessions.map(s => localPointsMap.get(s.date)).filter((p): p is ScanHistoryPoint => p !== undefined));
          },
        }
      );

      if (!ac.signal.aborted) {
        setPoints(result.points);
        setStatus('completed');
        // If no session is selected yet, select the last session
        if (result.points.length > 0 && !selectedPoint) {
          setSelectedPoint(result.points[result.points.length - 1]);
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

  // SVG Chart Geometry
  const chartHeight = 120;
  const maxCount = useMemo(() => {
    if (!points.length) return 10;
    const max = Math.max(...points.map(p => p.count));
    return max > 0 ? max : 10;
  }, [points]);

  const filteredDrilldownSymbols = useMemo(() => {
    if (!selectedPoint) return [];
    if (!symbolFilter.trim()) return selectedPoint.symbols;
    const q = symbolFilter.trim().toUpperCase();
    return selectedPoint.symbols.filter(s => s.toUpperCase().includes(q));
  }, [selectedPoint, symbolFilter]);

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
              <h3 className="text-sm font-semibold tracking-tight">Historical Scan Backtest</h3>
              <span className="rounded-full bg-subtle px-2 py-0.5 text-[11px] font-medium text-muted-text">
                Chartink-style
              </span>
            </div>
            <p className="text-xs text-muted-text">
              Evaluate this filter combination across historical trading sessions to analyze hit frequency & breadth.
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
                }}
                disabled={status === 'running'}
                className={`rounded-md px-2.5 py-1 transition-colors ${
                  range === option
                    ? 'bg-surface font-semibold text-text shadow-xs'
                    : 'text-muted-text hover:text-text'
                }`}
              >
                {option === 'all' ? `All (${availableSessions.length})` : `${option} Sessions`}
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
              className="flex items-center gap-1.5 rounded-lg bg-accent px-3.5 py-1.5 text-xs font-medium text-white hover:opacity-95 shadow-xs"
            >
              {points.length > 0 ? <RotateCcw size={13} /> : <Play size={13} />}
              {points.length > 0 ? 'Re-run Backtest' : 'Run Backtest'}
            </button>
          )}

          <button
            type="button"
            onClick={onClose}
            aria-label="Close scan backtest"
            className="flex h-7 w-7 items-center justify-center rounded-lg text-muted-text hover:bg-subtle hover:text-text"
          >
            <X size={15} />
          </button>
        </div>
      </div>

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

      {/* Summary KPI Cards (Rendered once scan has points or completed) */}
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
              <span className="text-[11px] font-normal text-muted-text">of days</span>
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
                  <span className="text-accent">{hoveredPoint.count} stocks</span>
                </div>
                {hoveredPoint.symbols.length > 0 && (
                  <div className="mt-0.5 text-[11px] text-muted-text">
                    Top: {hoveredPoint.symbols.slice(0, 5).join(', ')}
                    {hoveredPoint.symbols.length > 5 ? ` (+${hoveredPoint.symbols.length - 5} more)` : ''}
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
                {/* Y-axis gridline */}
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
                  const barHeight = p.count > 0 ? Math.max(4, (p.count / maxCount) * (chartHeight - 10)) : 1;
                  const y = chartHeight - barHeight;
                  const isSelected = selectedPoint?.date === p.date;
                  const isCurrentSession = currentSessionDate === p.date;

                  return (
                    <g
                      key={p.date}
                      className="cursor-pointer transition-opacity"
                      onMouseEnter={() => setHoveredPoint(p)}
                      onMouseLeave={() => setHoveredPoint(null)}
                      onClick={() => setSelectedPoint(p)}
                    >
                      {/* Bar rectangle */}
                      <rect
                        x={x}
                        y={y}
                        width={barWidth}
                        height={barHeight}
                        rx={barWidth > 4 ? 2 : 0}
                        className={`transition-colors ${
                          isSelected
                            ? 'fill-accent'
                            : isCurrentSession
                            ? 'fill-emerald-500'
                            : p.count > 0
                            ? 'fill-accent/70 hover:fill-accent'
                            : 'fill-muted-text/20 hover:fill-muted-text/40'
                        }`}
                      />
                      {/* Current session indicator tick */}
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
                  <div className="flex h-6 w-6 items-center justify-center rounded-md bg-accent/15 text-accent text-xs font-bold">
                    {selectedPoint.count}
                  </div>
                  <div>
                    <span className="text-xs font-semibold text-text">
                      {selectedPoint.date} Session
                    </span>
                    <span className="ml-2 text-[11px] text-muted-text">
                      {selectedPoint.count === 1 ? '1 stock passed' : `${selectedPoint.count} stocks passed`}
                    </span>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  {selectedPoint.symbols.length > 0 && (
                    <button
                      type="button"
                      onClick={() => handleCopySymbols(selectedPoint.symbols)}
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
              {selectedPoint.symbols.length > 8 && (
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
                {filteredDrilldownSymbols.length > 0 ? (
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
                    {selectedPoint.count === 0
                      ? 'No stocks passed this filter on this trading day.'
                      : 'No symbols match your filter.'}
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
          <h4 className="text-sm font-medium text-text">Ready to Backtest</h4>
          <p className="mt-1 max-w-sm text-xs text-muted-text">
            Test how frequently this filter triggered across {targetSessions.length} past sessions.
          </p>
          <button
            type="button"
            onClick={handleStartScan}
            className="mt-3 flex items-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-xs font-semibold text-white shadow-xs hover:opacity-95"
          >
            <Play size={14} />
            Start Scan ({targetSessions.length} Sessions)
          </button>
        </div>
      ) : null}
    </div>
  );
};
