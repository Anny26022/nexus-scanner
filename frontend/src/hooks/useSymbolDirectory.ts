import { useQuery } from '@tanstack/react-query';
import { screenerApi } from '../api/screenerApi';

export interface SymbolEntry { symbol: string; name: string }

/** Every Mainboard symbol with its company name for one release; loaded on demand and cached. */
export function useSymbolDirectory(datasetRevision: string | undefined, sessionDate: string | undefined, enabled = true) {
  return useQuery({
    queryKey: ['symbol-directory', datasetRevision, sessionDate],
    queryFn: async (): Promise<SymbolEntry[]> => (await screenerApi.getChartRows(datasetRevision, sessionDate))
      .map(row => ({symbol: row.symbol, name: row.name ?? ''})),
    enabled: enabled && Boolean(sessionDate),
    staleTime: Infinity,
  });
}

/** Ticker prefix first, then ticker substring, then company name; list order (market cap) breaks ties. */
export function rankSymbols(entries: readonly SymbolEntry[], query: string, limit = 8): SymbolEntry[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  return entries
    .map(entry => {
      const symbol = entry.symbol.toLowerCase();
      return {entry, rank: symbol === needle ? -1 : symbol.startsWith(needle) ? 0 : symbol.includes(needle) ? 1 : entry.name.toLowerCase().includes(needle) ? 2 : 3};
    })
    .filter(item => item.rank < 3)
    .sort((a, b) => a.rank - b.rank)
    .slice(0, limit)
    .map(item => item.entry);
}
