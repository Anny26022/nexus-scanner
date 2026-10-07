import { unpackSnapshot } from './packedSnapshot';
import { screenSnapshot, type Snapshot } from './snapshotScreen';
import type { ScreenerRunRequest, ScreenerRunResponse, SymbolComparisonResponse } from '../types/screener';

export interface SnapshotSource { revision: string; url: string; sessionDate?: string }
export type SnapshotTask =
  | { type:'screen'; source:SnapshotSource; request:ScreenerRunRequest }
  | { type:'compare'; source:SnapshotSource; symbols:string[] };
export type SnapshotResult =
  | { type:'screen'; result:ScreenerRunResponse | null; revision:string; sessionDate:string }
  | { type:'compare'; result:SymbolComparisonResponse };

async function readSnapshot(source: SnapshotSource): Promise<Snapshot> {
  const response = await fetch(source.url, {cache:'force-cache'});
  if (!response.ok) throw new Error(`Snapshot request failed (HTTP ${response.status})`);
  let data: Snapshot;
  if (source.url.endsWith('.gz')) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
      const stream = new Response(bytes).body!.pipeThrough(new DecompressionStream('gzip'));
      data = JSON.parse(await new Response(stream).text());
    } else if (response.headers.get('Content-Encoding')?.toLowerCase() === 'gzip') {
      data = JSON.parse(new TextDecoder().decode(bytes));
    } else throw new Error('Invalid compressed scanner snapshot');
  } else data = await response.json();
  data = unpackSnapshot(data) as Snapshot;
  if (!data || data.revision !== source.revision || !Array.isArray(data.stocks)
      || data.totalStocks !== data.stocks.length || !/^\d{4}-\d{2}-\d{2}$/.test(data.asOfDate)
      || (source.sessionDate && data.asOfDate !== source.sessionDate)) {
    throw new Error('Scanner snapshot revision/session mismatch');
  }
  return data;
}

export function createSnapshotEngine(loader = readSnapshot) {
  const snapshots = new Map<string, Promise<Snapshot>>();
  async function load(source: SnapshotSource) {
    if (!/^[a-f0-9]{64}$/.test(source.revision)) throw new Error('Invalid dataset revision');
    let promise = snapshots.get(source.revision);
    if (!promise) {
      promise = loader(source).catch(error => {
        if (snapshots.get(source.revision) === promise) snapshots.delete(source.revision);
        throw error;
      });
      snapshots.set(source.revision,promise);
      if (snapshots.size > 2) snapshots.delete(snapshots.keys().next().value!);
    }
    return promise;
  }
  return async (task: SnapshotTask): Promise<SnapshotResult> => {
    const data = await load(task.source);
    if (task.type === 'screen') return {type:'screen',result:screenSnapshot(data,task.request),revision:data.revision,sessionDate:data.asOfDate};
    const bySymbol = new Map(data.stocks.map(stock => [stock.symbol,stock]));
    const validSymbols: SymbolComparisonResponse['validSymbols'] = [], invalidSymbols:string[] = [];
    for (const input of task.symbols) {
      const symbol = input.trim().toUpperCase(), stock = bySymbol.get(symbol);
      if (!stock) { invalidSymbols.push(symbol); continue; }
      validSymbols.push({...stock,rvol:stock.rvol ?? 0,isValid:true,
        sma50Status:stock.sma50 == null ? 'Unavailable' : stock.close > stock.sma50 ? 'Above SMA50' : 'Below SMA50'});
    }
    return {type:'compare',result:{validSymbols,invalidSymbols,sessionDate:data.asOfDate,immutableRevision:data.revision}};
  };
}
