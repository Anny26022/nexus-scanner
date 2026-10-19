import { unpackSnapshot } from './packedSnapshot';
import { screenSnapshot, type Snapshot } from './snapshotScreen';
import type { ScreenerRunRequest, ScreenerRunResponse, SymbolComparisonResponse } from '../types/screener';
import {tradingViewMetrics} from '../data/tradingViewMetrics';

export interface SnapshotSource { revision: string; url: string; sessionDate?: string }
import type {FilterChoices} from '../types/filterChoices';
export type {FilterChoices} from '../types/filterChoices';
export type SnapshotTask =
  | { type:'warm'; source:SnapshotSource }
  | { type:'filterChoices'; source:SnapshotSource }
  | { type:'screen'; source:SnapshotSource; request:ScreenerRunRequest; allRows?:boolean }
  | { type:'compare'; source:SnapshotSource; symbols:string[] };
export type SnapshotResult =
  | { type:'warm' }
  | { type:'filterChoices'; result:FilterChoices }
  | { type:'screen'; result:ScreenerRunResponse | null; revision:string; sessionDate:string }
  | { type:'compare'; result:SymbolComparisonResponse };

async function readSnapshot(source: SnapshotSource, signal?: AbortSignal): Promise<Snapshot> {
  const response = await fetch(source.url, {cache:'force-cache', signal});
  if (!response.ok) throw new Error(`Snapshot request failed (HTTP ${response.status})`);
  let data: Snapshot;
  if (source.url.split('?')[0].endsWith('.gz')) {
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
  async function load(source: SnapshotSource, signal?: AbortSignal) {
    if (!/^[a-f0-9]{64}$/.test(source.revision)) throw new Error('Invalid dataset revision');
    const key = source.sessionDate ? `${source.revision}:${source.sessionDate}` : source.revision;
    let promise = snapshots.get(key);
    if (!promise) {
      promise = loader(source, signal).catch(error => {
        if (snapshots.get(key) === promise) snapshots.delete(key);
        throw error;
      });
      snapshots.set(key, promise);
      if (snapshots.size > 2) snapshots.delete(snapshots.keys().next().value!);
    }
    return promise;
  }

  return async (task: SnapshotTask, signal?: AbortSignal): Promise<SnapshotResult> => {
    const data = await load(task.source, signal);
    if (task.type === 'warm') return {type:'warm'};
    if (task.type === 'filterChoices') {
      const fields = {SECTOR:'sector', INDUSTRY:'industry', SERIES:'series', PRICE_BAND:'circuitLimit', INDEX_MEMBERSHIP:'indexMemberships'} as const;
      const result = Object.fromEntries(Object.entries(fields).map(([id, field]) => {
        const values = new Map<string, string>();
        for (const stock of data.stocks) {
          const raw = stock[field];
          for (const value of Array.isArray(raw) ? raw : [raw]) {
            if (typeof value === 'string' && value.trim()) values.set(value.trim().toUpperCase(), value.trim());
          }
        }
        return [id, [...values.values()].sort((a,b) => a.localeCompare(b))];
      })) as FilterChoices;
      if (data.tradingViewMetricsVersion === 1) {
        result.TRADINGVIEW_METRIC = tradingViewMetrics.filter(metric => data.stocks.some(stock =>
          stock.tradingview?.asOfDate === data.asOfDate && typeof stock.tradingview.values[metric.id] === 'number'
          && Number.isFinite(stock.tradingview.values[metric.id]))).map(metric => metric.id);
      }
      return {type:'filterChoices', result};
    }
    if (task.type === 'screen') return {type:'screen',result:screenSnapshot(data,task.request,task.allRows),revision:data.revision,sessionDate:data.asOfDate};
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
