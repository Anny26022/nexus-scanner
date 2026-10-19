import { getManifest, manifestSnapshotSource } from './manifest';
import { runSnapshotTask } from './snapshotClient';
import type { ScreenerRunRequest, ExpressionNode, UniverseType } from '../types/screener';

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
}

export interface ScanHistorySummary {
  totalSessions: number;
  evaluatedSessions: number;
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

const scanHistoryCache = new Map<string, ScanHistoryPoint>();

export function getScanHistoryCacheKey(date: string, universe: UniverseType, expressionTree: ExpressionNode): string {
  return `${date}:${universe}:${JSON.stringify(expressionTree)}`;
}

export async function runScanHistorySession(
  session: ScanSession,
  expressionTree: ExpressionNode,
  universe: UniverseType,
  customSymbols?: string[]
): Promise<ScanHistoryPoint> {
  const cacheKey = getScanHistoryCacheKey(session.date, universe, expressionTree);
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
    pageSize: 100,
  };

  const snapshot = await runSnapshotTask({
    type: 'screen',
    source,
    request,
    allRows: true,
  });

  if (snapshot.type !== 'screen' || !snapshot.result) {
    throw new Error(`Failed to screen session ${session.date}`);
  }

  const point: ScanHistoryPoint = {
    date: session.date,
    count: snapshot.result.matchCount,
    symbols: snapshot.result.matchedSymbols || snapshot.result.rows.map(r => r.symbol),
  };

  scanHistoryCache.set(cacheKey, point);
  return point;
}

export function computeScanHistorySummary(points: ScanHistoryPoint[], totalSessions: number): ScanHistorySummary {
  if (!points.length) {
    return {
      totalSessions,
      evaluatedSessions: 0,
      averageMatches: 0,
      peakDate: '-',
      peakCount: 0,
      lowestDate: '-',
      lowestCount: 0,
      frequencyPct: 0,
    };
  }

  let totalMatches = 0;
  let peakPoint = points[0];
  let lowestPoint = points[0];
  let nonZeroCount = 0;

  for (const p of points) {
    totalMatches += p.count;
    if (p.count > peakPoint.count) peakPoint = p;
    if (p.count < lowestPoint.count) lowestPoint = p;
    if (p.count > 0) nonZeroCount++;
  }

  return {
    totalSessions,
    evaluatedSessions: points.length,
    averageMatches: Math.round((totalMatches / points.length) * 10) / 10,
    peakDate: peakPoint.date,
    peakCount: peakPoint.count,
    lowestDate: lowestPoint.date,
    lowestCount: lowestPoint.count,
    frequencyPct: Math.round((nonZeroCount / points.length) * 100),
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
        // If single session fails, record 0 or log without breaking the rest
        console.warn(`Historical scan error for ${session.date}:`, err);
        const fallbackPoint: ScanHistoryPoint = { date: session.date, count: 0, symbols: [] };
        resultsMap.set(session.date, fallbackPoint);
        completed++;
        onProgress?.(
          {
            current: completed,
            total,
            latestPoint: fallbackPoint,
            pct: Math.round((completed / total) * 100),
          },
          fallbackPoint
        );
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, sessions.length) }, () => worker());
  await Promise.all(workers);

  // Return points in original order of input sessions
  const points = sessions
    .map(s => resultsMap.get(s.date))
    .filter((p): p is ScanHistoryPoint => p !== undefined);

  return {
    points,
    summary: computeScanHistorySummary(points, total),
  };
}
