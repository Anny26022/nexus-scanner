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

/** Warm one neighbour after the selected chart finishes, without competing with its requests. */
export function prefetchCharts(client: QueryClient, symbols: readonly string[], symbol: string, datasetRevision?: string, sessionDate?: string, direction: 1 | -1 = 1) {
  if (!datasetRevision) return;
  const at = symbols.indexOf(symbol);
  if (at === -1 || symbols.length < 2) return;
  const neighbour = symbols[(at + direction + symbols.length) % symbols.length];
  void client.fetchQuery(chartQuery(datasetRevision, symbol, sessionDate))
    .then(() => client.prefetchQuery(chartQuery(datasetRevision, neighbour, sessionDate)))
    .catch(() => undefined);
}
