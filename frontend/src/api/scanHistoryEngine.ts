import { getManifest, manifestSnapshotSource } from './manifest';
import { runSnapshotTask } from './snapshotClient';
import type { ScreenerRunRequest, ExpressionNode, UniverseType } from '../types/screener';
import { isTradingViewCondition } from '../data/tradingViewMetrics';

export interface ScanSession {
  date: string;
  revision: string;
  label?: string;
  isHistorical?: boolean;
}

export interface ScanHistoryPoint {
  date: string;
  count: number;
  status: 'success' | 'error' | 'unsupported';
  error?: string;
  // symbols are loaded on demand during drilldown inspection to minimize memory
  symbols?: string[];
  sectorCounts?: Record<string, number>;
}

export interface ScanHistorySummary {
  totalSessions: number;
  evaluatedSessions: number;
  failedSessions: number;
  averageMatches: number;
  peakDate: string;
  peakCount: number;
  lowestDate: string;
  lowestCount: number;
  frequencyPct: number;
}

export interface ScanHistoryProgress {
  current: number;
  total: number;
  latestPoint?: ScanHistoryPoint;
  pct: number;
}

export interface ScanCompatibilityResult {
  compatible: boolean;
  reason?: string;
}

class LruMap<K, V> {
  private map = new Map<K, V>();
  constructor(private max: number) {}

  get(key: K): V | undefined {
    const val = this.map.get(key);
    if (val !== undefined) {
      this.map.delete(key);
      this.map.set(key, val);
    }
    return val;
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(key, value);
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  delete(key: K): boolean {
    return this.map.delete(key);
  }

  get size(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }
}

export const SCAN_HISTORY_CACHE_MAX = 200;
export const scanHistoryCache = new LruMap<string, ScanHistoryPoint>(SCAN_HISTORY_CACHE_MAX);
export const sessionSymbolsCache = new LruMap<string, string[]>(SCAN_HISTORY_CACHE_MAX);

export function getScanHistoryCacheKey(
  date: string,
  revision: string,
  universe: UniverseType,
  expressionTree: ExpressionNode,
  customSymbols?: string[]
): string {
  const custom = customSymbols && customSymbols.length > 0 ? customSymbols.slice().sort().join(',') : '';
  return `${date}:${revision}:${universe}:${custom}:${JSON.stringify(expressionTree)}`;
}

export function checkScanCompatibility(tree: ExpressionNode): ScanCompatibilityResult {
  function inspect(node: ExpressionNode): string | null {
    if (node.type === 'group') {
      for (const child of node.children) {
        const res = inspect(child);
        if (res) return res;
      }
      return null;
    }
    const id = node.condition.conditionId;
    if (id === 'FNO_BAN') {
      return 'F&O Ban status is an exchange live-session metric and is not archived in historical snapshots.';
    }
    if (isTradingViewCondition(id)) {
      return 'TradingView technical metrics are available on live sessions only and are not archived historically.';
    }
    return null;
  }

  const reason = inspect(tree);
  return reason ? { compatible: false, reason } : { compatible: true };
}

export async function runScanHistorySession(
  session: ScanSession,
  expressionTree: ExpressionNode,
  universe: UniverseType,
  customSymbols?: string[],
  signal?: AbortSignal
): Promise<ScanHistoryPoint> {
  const cacheKey = getScanHistoryCacheKey(session.date, session.revision, universe, expressionTree, customSymbols);
  const cached = scanHistoryCache.get(cacheKey);
  if (cached) return cached;

  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

  const manifest = await getManifest();
  const source = manifestSnapshotSource(manifest, session.revision, session.date);

  const request: ScreenerRunRequest = {
    expressionTree,
    universe,
    customSymbols,
    asOfDate: session.date,
    datasetRevision: session.revision,
    page: 1,
    pageSize: 1,
    countsOnly: true,
  };

  const snapshot = await runSnapshotTask({
    type: 'screen',
    source,
    request,
    allRows: false,
  }, signal);

  if (snapshot.type !== 'screen' || !snapshot.result) {
    throw new Error(`Failed to screen session ${session.date}`);
  }

  // Count only returned for histogram; symbols loaded on demand when user clicks that date
  const point: ScanHistoryPoint = {
    date: session.date,
    count: snapshot.result.matchCount,
    status: 'success',
    sectorCounts: snapshot.result.sectorCounts,
  };

  // Cache symbols separately if provided (e.g. if loaded on-demand)
  if (snapshot.result.matchedSymbols && snapshot.result.matchedSymbols.length > 0) {
    sessionSymbolsCache.set(cacheKey, snapshot.result.matchedSymbols);
  }

  scanHistoryCache.set(cacheKey, point);
  return point;
}

export async function loadSessionSymbols(
  session: ScanSession,
  expressionTree: ExpressionNode,
  universe: UniverseType,
  customSymbols?: string[],
  signal?: AbortSignal
): Promise<string[]> {
  const cacheKey = getScanHistoryCacheKey(session.date, session.revision, universe, expressionTree, customSymbols);
  const cached = sessionSymbolsCache.get(cacheKey);
  if (cached) return cached;

  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

  const manifest = await getManifest();
  const source = manifestSnapshotSource(manifest, session.revision, session.date);

  const request: ScreenerRunRequest = {
    expressionTree,
    universe,
    customSymbols,
    asOfDate: session.date,
    datasetRevision: session.revision,
    page: 1,
    pageSize: 1,
  };

  const snapshot = await runSnapshotTask({
    type: 'screen',
    source,
    request,
    allRows: false,
  }, signal);

  if (snapshot.type !== 'screen' || !snapshot.result) {
    throw new Error(`Failed to load symbols for session ${session.date}`);
  }

  const symbols = snapshot.result.matchedSymbols || snapshot.result.rows.map(r => r.symbol);
  sessionSymbolsCache.set(cacheKey, symbols);
  return symbols;
}

export function computeScanHistorySummary(points: ScanHistoryPoint[], totalSessions: number): ScanHistorySummary {
  const successPoints = points.filter(p => p.status === 'success');
  const failedSessions = points.length - successPoints.length;

  if (!successPoints.length) {
    return {
      totalSessions,
      evaluatedSessions: 0,
      failedSessions,
      averageMatches: 0,
      peakDate: '-',
      peakCount: 0,
      lowestDate: '-',
      lowestCount: 0,
      frequencyPct: 0,
    };
  }

  let totalMatches = 0;
  let peakPoint = successPoints[0];
  let lowestPoint = successPoints[0];
  let nonZeroCount = 0;

  for (const p of successPoints) {
    totalMatches += p.count;
    if (p.count > peakPoint.count) peakPoint = p;
    if (p.count < lowestPoint.count) lowestPoint = p;
    if (p.count > 0) nonZeroCount++;
  }

  return {
    totalSessions,
    evaluatedSessions: successPoints.length,
    failedSessions,
    averageMatches: Math.round((totalMatches / successPoints.length) * 10) / 10,
    peakDate: peakPoint.date,
    peakCount: peakPoint.count,
    lowestDate: lowestPoint.date,
    lowestCount: lowestPoint.count,
    frequencyPct: Math.round((nonZeroCount / successPoints.length) * 100),
  };
}

export async function executeScanHistory(
  sessions: ScanSession[],
  expressionTree: ExpressionNode,
  universe: UniverseType,
  customSymbols?: string[],
  options: {
    concurrency?: number;
    signal?: AbortSignal;
    onProgress?: (progress: ScanHistoryProgress, point: ScanHistoryPoint) => void;
  } = {}
): Promise<{ points: ScanHistoryPoint[]; summary: ScanHistorySummary }> {
  // Adaptive concurrency default: 2 concurrent fetches to bound peak memory and prevent tab pressure
  const { concurrency = 2, signal, onProgress } = options;
  const total = sessions.length;
  const resultsMap = new Map<string, ScanHistoryPoint>();
  let completed = 0;

  let index = 0;
  async function worker() {
    while (index < sessions.length) {
      if (signal?.aborted) break;
      const currentIndex = index++;
      const session = sessions[currentIndex];
      try {
        const point = await runScanHistorySession(session, expressionTree, universe, customSymbols, signal);
        if (signal?.aborted) break;
        resultsMap.set(session.date, point);
        completed++;
        onProgress?.(
          {
            current: completed,
            total,
            latestPoint: point,
            pct: Math.round((completed / total) * 100),
          },
          point
        );
      } catch (err) {
        if (signal?.aborted) break;
        const message = err instanceof Error ? err.message : 'Evaluation failed';
        const isUnsupported = message.includes('not archived') || message.includes('newer dataset');
        const errorPoint: ScanHistoryPoint = {
          date: session.date,
          count: 0,
          status: isUnsupported ? 'unsupported' : 'error',
          error: message,
        };
        resultsMap.set(session.date, errorPoint);
        completed++;
        onProgress?.(
          {
            current: completed,
            total,
            latestPoint: errorPoint,
            pct: Math.round((completed / total) * 100),
          },
          errorPoint
        );
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, sessions.length) }, () => worker());
  await Promise.all(workers);

  const points = sessions
    .map(s => resultsMap.get(s.date))
    .filter((p): p is ScanHistoryPoint => p !== undefined);

  return {
    points,
    summary: computeScanHistorySummary(points, total),
  };
}
