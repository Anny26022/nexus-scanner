import { getIpoJson } from './gzipJson';
import type { FinancialHistory } from '../chart/fundamentals';
import { unpackSnapshot } from './packedSnapshot';
import { screenSnapshot, type Snapshot } from './snapshotScreen';
import type { ScreenerRunRequest, ScreenerRunResponse, SymbolComparisonResponse } from '../types/screener';
import {etfGroups} from '../data/etfFields';
import {extendedMetrics} from '../data/extendedMetrics';
import {CLASSIFICATION_FILTERS, classificationLabels, isClassificationFilter, validateClassification, type ThemeClassification} from '../data/classification';

export interface SnapshotSource {
  revision: string; url: string; sessionDate?: string;
  classificationUrl?: string; classificationVersion?: string;
}
import type {FilterChoices} from '../types/filterChoices';
export type {FilterChoices} from '../types/filterChoices';
export type SnapshotTask =
  | { type:'financialHistory'; source:SnapshotSource; symbol:string }
  | { type:'warm'; source:SnapshotSource }
  | { type:'filterChoices'; source:SnapshotSource }
  | { type:'screen'; source:SnapshotSource; request:ScreenerRunRequest; allRows?:boolean }
  | { type:'compare'; source:SnapshotSource; symbols:string[] };
export type SnapshotResult =
  | { type:'financialHistory'; result:FinancialHistory | null }
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
  const snapshots = new Map<string, Snapshot>();
  const financialHistories = new Map<string, Promise<Record<string, FinancialHistory>>>();
  const classifications = new Map<string, Promise<ThemeClassification>>();
  const classifiedSnapshots = new WeakMap<Snapshot, {url:string; data:Snapshot}>();

  interface Subscriber {
    signal?: AbortSignal;
    onAbort?: () => void;
    resolve: (data: Snapshot) => void;
    reject: (err: any) => void;
  }

  interface InFlightEntry {
    controller: AbortController;
    subscribers: Set<Subscriber>;
    promise: Promise<Snapshot>;
  }

  const inFlight = new Map<string, InFlightEntry>();

  async function load(source: SnapshotSource, signal?: AbortSignal): Promise<Snapshot> {
    if (!/^[a-f0-9]{64}$/.test(source.revision)) throw new Error('Invalid dataset revision');
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    const key = `${source.url}:${source.revision}:${source.sessionDate ?? ''}`;

    const cached = snapshots.get(key);
    if (cached) {
      snapshots.delete(key);
      snapshots.set(key, cached);
      return cached;
    }

    let entry = inFlight.get(key);
    if (!entry) {
      const fetchController = new AbortController();
      let loadPromise: Promise<Snapshot>;
      try {
        loadPromise = Promise.resolve(loader(source, fetchController.signal));
      } catch (err) {
        loadPromise = Promise.reject(err);
      }
      const newEntry: InFlightEntry = {
        controller: fetchController,
        subscribers: new Set(),
        promise: loadPromise
          .then(data => {
            snapshots.set(key, data);
            if (snapshots.size > 2) snapshots.delete(snapshots.keys().next().value!);
            return data;
          })
          .finally(() => {
            if (inFlight.get(key) === newEntry) inFlight.delete(key);
          }),
      };
      entry = newEntry;
      inFlight.set(key, entry);
    }

    const activeEntry = entry;
    return new Promise<Snapshot>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new DOMException('Aborted', 'AbortError'));
        return;
      }

      const subscriber: Subscriber = {
        signal,
        resolve,
        reject,
      };

      if (signal) {
        subscriber.onAbort = () => {
          activeEntry.subscribers.delete(subscriber);
          // Only abort the underlying fetch if no subscribers remain waiting for this load
          if (activeEntry.subscribers.size === 0) {
            activeEntry.controller.abort();
            if (inFlight.get(key) === activeEntry) inFlight.delete(key);
          }
          reject(new DOMException('Aborted', 'AbortError'));
        };
        signal.addEventListener('abort', subscriber.onAbort, { once: true });
      }

      activeEntry.subscribers.add(subscriber);

      activeEntry.promise
        .then(data => {
          activeEntry.subscribers.delete(subscriber);
          if (subscriber.signal && subscriber.onAbort) {
            subscriber.signal.removeEventListener('abort', subscriber.onAbort);
          }
          resolve(data);
        })
        .catch(err => {
          activeEntry.subscribers.delete(subscriber);
          if (subscriber.signal && subscriber.onAbort) {
            subscriber.signal.removeEventListener('abort', subscriber.onAbort);
          }
          if (!signal?.aborted) {
            reject(err);
          }
        });
    });
  }

  return async (task: SnapshotTask, signal?: AbortSignal): Promise<SnapshotResult> => {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    if (task.type === 'financialHistory') {
      const url = task.source.url;
      let history = financialHistories.get(url);
      if (!history) {
        history = getIpoJson<Record<string, FinancialHistory>>(url, 'Financial history');
        financialHistories.set(url, history);
        if (financialHistories.size > 2) financialHistories.delete(financialHistories.keys().next().value!);
        history.catch(() => { if (financialHistories.get(url) === history) financialHistories.delete(url); });
      }
      return {type:'financialHistory', result:(await history)[task.symbol] ?? null};
    }
    let data = await load(task.source, signal);
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    if (task.type === 'warm') return {type:'warm'};
    const classificationRequired = (node: ScreenerRunRequest['expressionTree']): boolean =>
      node.type === 'condition' ? isClassificationFilter(node.condition.conditionId) : node.children.some(classificationRequired);
    if (task.source.classificationUrl && (task.type === 'filterChoices'
        || task.type === 'screen' && classificationRequired(task.request.expressionTree))) {
      const url = task.source.classificationUrl;
      const joined = classifiedSnapshots.get(data);
      if (joined && joined.data.classificationVersion !== task.source.classificationVersion) throw new Error('Classification release mismatch');
      if (joined?.url === url) data = joined.data;
      else {
        let pending = classifications.get(url);
        if (!pending) {
          pending = getIpoJson<ThemeClassification>(url, 'Classifications');
          classifications.set(url, pending);
          if (classifications.size > 3) classifications.delete(classifications.keys().next().value!);
          pending.catch(() => { if (classifications.get(url) === pending) classifications.delete(url); });
        }
        const taxonomy = await pending;
        if (taxonomy.version !== task.source.classificationVersion || taxonomy.asOfDate !== data.asOfDate
            || taxonomy.schemaVersion !== 2 || data.classificationVersion !== taxonomy.version) throw new Error('Classification release mismatch');
        validateClassification(taxonomy, data.totalStocks);
        if (data.stocks.some(stock => !Object.hasOwn(taxonomy.records, stock.symbol))) throw new Error('Classification security universe mismatch');
        const classified = {...data, classificationNodes:taxonomy.nodes,
          stocks:data.stocks.map(stock => ({...stock, classification:taxonomy.records[stock.symbol]}))};
        classifiedSnapshots.set(data, {url, data:classified});
        data = classified;
      }
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    }
    if (task.type === 'filterChoices') {
      const fields = {SECTOR:'sector', INDUSTRY:'industry', SERIES:'series', PRICE_BAND:'circuitLimit', INDEX_MEMBERSHIP:'indexMemberships'} as const;
      const result: FilterChoices = Object.fromEntries(Object.entries(fields).map(([id, field]) => {
        const values = new Map<string, string>();
        for (const stock of data.stocks) {
          const raw = stock[field];
          for (const value of Array.isArray(raw) ? raw : [raw]) {
            if (typeof value === 'string' && value.trim()) values.set(value.trim().toUpperCase(), value.trim());
          }
        }
        return [id, [...values.values()].sort((a,b) => a.localeCompare(b))];
      })) as Record<keyof typeof fields, string[]>;
      for (const [id, level] of Object.entries(CLASSIFICATION_FILTERS)) {
        if (!data.stocks.some(stock => stock.classification)) continue;
        result[id as keyof typeof CLASSIFICATION_FILTERS] = [...new Set(data.stocks.flatMap(stock =>
          classificationLabels(stock, stock.classification, level)))].sort((a, b) => a.localeCompare(b));
      }
      if (data.assetType === 'etf') {
        result.ETF_FIELDS = [];
        result.ETF_VALUES = {};
        result.ETF_LABELS = data.etfLabels;
        const currentRows = data.stocks.filter(stock => stock.asOfDate === data.asOfDate);
        for (const group of etfGroups) for (const field of group.fields) {
          const values = currentRows.map(stock => stock.etf?.[field]).filter(value => value != null);
          if (values.length) result.ETF_FIELDS.push(field);
          if (group.type !== 'number') result.ETF_VALUES[field] = [...new Set(values.map(String))].sort();
        }
      }
      if (data.extendedMetricsVersion === 1) {
        result.TRADINGVIEW_METRIC = extendedMetrics.filter(metric => data.stocks.some(stock =>
          stock.extended?.asOfDate === data.asOfDate && typeof stock.extended.values[metric.id] === 'number'
          && Number.isFinite(stock.extended.values[metric.id]))).map(metric => metric.id);
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
