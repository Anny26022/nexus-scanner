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
  symbols: string[];
  status: 'success' | 'error' | 'unsupported';
  error?: string;
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

const scanHistoryCache = new Map<string, ScanHistoryPoint>();

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
  customSymbols?: string[]
): Promise<ScanHistoryPoint> {
  const cacheKey = getScanHistoryCacheKey(session.date, session.revision, universe, expressionTree, customSymbols);
  const cached = scanHistoryCache.get(cacheKey);
  if (cached) return cached;

  const manifest = await getManifest();
  const source = manifestSnapshotSource(manifest, session.revision, session.date);

  const request: ScreenerRunRequest = {
    expressionTree,
    universe,
    customSymbols,
    asOfDate: session.date,
    datasetRevision: session.revision,
    page: 1,
    pageSize: 1, // Only need 1 row; matchedSymbols contains all passing symbol names
  };

  const snapshot = await runSnapshotTask({
    type: 'screen',
    source,
    request,
    allRows: false, // Avoid expensive structured clone transfer of full row objects
  });

  if (snapshot.type !== 'screen' || !snapshot.result) {
    throw new Error(`Failed to screen session ${session.date}`);
  }

  const point: ScanHistoryPoint = {
    date: session.date,
    count: snapshot.result.matchCount,
    symbols: snapshot.result.matchedSymbols || snapshot.result.rows.map(r => r.symbol),
    status: 'success',
  };

  scanHistoryCache.set(cacheKey, point);
  return point;
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
  const { concurrency = 4, signal, onProgress } = options;
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
        const point = await runScanHistorySession(session, expressionTree, universe, customSymbols);
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
          symbols: [],
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
