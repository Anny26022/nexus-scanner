import type { QueryClient } from '@tanstack/react-query';
import { screenerApi } from '../api/screenerApi';
import { validateCandles } from './model';

/** One symbol's published chart. Shared so a prefetch fills the same cache entry the chart reads. */
export const chartQuery = (datasetRevision: string | undefined, symbol: string, sessionDate?: string) => ({
  queryKey: ['chart', datasetRevision, symbol, sessionDate] as const,
  queryFn: async () => {
    const snapshot = await screenerApi.getChart(symbol, datasetRevision, sessionDate);
    return {...snapshot, candles: validateCandles(snapshot.candles)};
  },
  staleTime: Infinity,
  retry: false,
});

/**
 * Warms the charts around `symbol` in a list: each costs about two round trips to the data server,
 * so stepping down a watchlist finds the next charts already loaded. Failures stay silent; opening
 * the chart retries and shows its own error.
 */
export function prefetchCharts(client: QueryClient, symbols: readonly string[], symbol: string, datasetRevision?: string, sessionDate?: string) {
  if (!datasetRevision) return;
  const at = symbols.indexOf(symbol);
  if (at === -1) return;
  for (const next of [at + 1, at + 2, at + 3, at - 1]) {
    const neighbour = symbols[next];
    if (neighbour) void client.prefetchQuery(chartQuery(datasetRevision, neighbour, sessionDate));
  }
}
