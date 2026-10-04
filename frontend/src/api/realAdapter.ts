import type { ScreenerRunRequest, ScreenerRunResponse, IPORow, ExplainRequest, ExplainResponse,
  SymbolComparisonRequest, SymbolComparisonResponse, RevisionCurrentResponse } from '../types/screener';
import { NEXUS_CONDITION_CATALOG } from '../data/conditionCatalog';
import { screenSnapshot, type Snapshot } from './snapshotScreen';

interface Manifest {
  revision: string;
  sessionDate: string;
  datasetUrl: string;
  iposUrl: string;
  totalStocks: number;
  schemaVersion: number;
}
let current: Manifest | undefined;
const snapshots = new Map<string, Promise<Snapshot>>();
const ipoSnapshots = new Map<string, Promise<IPORow[]>>();

async function getJson<T>(url: string, fresh = false): Promise<T> {
  const response = await fetch(url, fresh ? { cache:'no-store' } : undefined);
  if (!response.ok) throw new Error(`Dataset request failed (HTTP ${response.status})`);
  return response.json();
}

async function getGzipJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Dataset request failed (HTTP ${response.status})`);
  if (!('DecompressionStream' in window)) throw new Error('This browser cannot read compressed IPO data');
  const stream = response.body?.pipeThrough(new DecompressionStream('gzip'));
  if (!stream) throw new Error('IPO dataset response has no body');
  return JSON.parse(await new Response(stream).text()) as T;
}

export async function refreshManifest(): Promise<Manifest> {
  const manifest = await getJson<Manifest>('/data/current.json', true);
  if (!/^[a-f0-9]{64}$/.test(manifest.revision) || manifest.schemaVersion !== 4) throw new Error('Invalid scanner dataset manifest');
  current = manifest;
  return manifest;
}

async function loadSnapshot(revision?: string): Promise<Snapshot> {
  const manifest = current ?? await refreshManifest();
  const selected = revision ?? manifest.revision;
  if (!/^[a-f0-9]{64}$/.test(selected)) throw new Error('Invalid dataset revision');
  if (!snapshots.has(selected)) {
    const loading = getJson<Snapshot>(`/data/revisions/${selected}/stocks.json`).then(data => {
      if (data.revision !== selected) throw new Error('Dataset revision mismatch');
      return data;
    }).catch(error => { snapshots.delete(selected); throw error; });
    snapshots.set(selected, loading);
    if (snapshots.size > 3) snapshots.delete(snapshots.keys().next().value!);
  }
  return snapshots.get(selected)!;
}

class RealDataAdapter {
  async getCatalog() { return NEXUS_CONDITION_CATALOG; }

  async explainScreen(_req: ExplainRequest): Promise<ExplainResponse> {
    return { isValid:true, errors:[], compiledExplanations:[], warnings:[] };
  }

  async runScreen(req: ScreenerRunRequest): Promise<ScreenerRunResponse> {
    const snapshot = await loadSnapshot(req.datasetRevision);
    const result = screenSnapshot(snapshot, req);
    if (result) return result;
    const base = (import.meta.env.VITE_API_BASE_URL || '/api').replace(/\/$/, '');
    const response = await fetch(`${base}/screens/run`, { method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({...req,asOfDate:snapshot.asOfDate,datasetRevision:snapshot.revision}) });
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.error) throw new Error(payload?.error || `Scanner request failed (HTTP ${response.status})`);
    if (payload?.immutableRevision !== snapshot.revision || !Array.isArray(payload.rows)) throw new Error('Scanner returned a different dataset revision');
    return payload;
  }

  async getIpos(): Promise<IPORow[]> {
    const manifest = current ?? await refreshManifest();
    if (!ipoSnapshots.has(manifest.revision)) {
      const revision = manifest.revision;
      const promise = getGzipJson<Record<string, any> | {records:Record<string, any>[]}>(manifest.iposUrl).then(payload => {
        const rows = Array.isArray(payload) ? payload : payload.records;
        return rows.map(r => ({
        symbol:r.symbol, name:r.name || r.company_name || '', listingDate:r.listing_date || '',
        currentPrice:r.close ?? 0, turnoverCrore:r.rupee_volume == null ? 0 : r.rupee_volume / 10_000_000,
        deliveryPct:r.delivery_percent ?? null,
        sector:r.sector || 'Unclassified', industry:r.industry || 'Unclassified', marketCapCrore:r.market_cap_crore ?? 0,
      }));
      }).catch(error => { ipoSnapshots.delete(revision); throw error; });
      ipoSnapshots.set(revision,promise);
      if (ipoSnapshots.size > 3) ipoSnapshots.delete(ipoSnapshots.keys().next().value!);
    }
    return ipoSnapshots.get(manifest.revision)!;
  }

  async compareSymbols(req: SymbolComparisonRequest): Promise<SymbolComparisonResponse> {
    const data = await loadSnapshot();
    const validSymbols: SymbolComparisonResponse['validSymbols'] = [], invalidSymbols: string[] = [];
    for (const input of req.symbols) {
      const symbol = input.trim().toUpperCase(), stock = data.stocks.find(s => s.symbol === symbol);
      if (!stock) { invalidSymbols.push(symbol); continue; }
      validSymbols.push({...stock,rvol:stock.rvol ?? 0,isValid:true,sma50Status:stock.sma50 == null ? 'Unavailable' : stock.close > stock.sma50 ? 'Above SMA50' : 'Below SMA50'});
    }
    return {validSymbols,invalidSymbols,sessionDate:data.asOfDate,immutableRevision:data.revision};
  }

  async getCurrentRevision(): Promise<RevisionCurrentResponse> {
    const manifest = await refreshManifest();
    return {latestSessionDate:manifest.sessionDate,availableSessions:[{date:manifest.sessionDate,label:'Latest',isHistorical:false}],
      immutableRevision:manifest.revision,mainboardUniverseCount:manifest.totalStocks,catalogVersion:'v4-snapshot'};
  }
}

export const realAdapter = new RealDataAdapter();
