import type { ScreenerRunRequest, ScreenerRunResponse, IPORow, ExplainRequest, ExplainResponse,
  SymbolComparisonRequest, SymbolComparisonResponse, RevisionCurrentResponse } from '../types/screener';
import { NEXUS_CONDITION_CATALOG } from '../data/conditionCatalog';
import { runSnapshotTask } from './snapshotClient';
import type { SnapshotSource } from './snapshotEngine';
import { expressionPlan } from './capabilityRegistry';
import type { PublicPacks } from './packStore';

interface Manifest {
  revision: string;
  sessionDate: string;
  datasetUrl: string;
  datasetGzipUrl?: string;
  iposUrl: string;
  totalStocks: number;
  schemaVersion: number;
  chartUrlTemplate?: string;
  chartRevision?: string;
  earningsCalendarUrl?: string;
  engineVersion?: string;
  packs?: PublicPacks;
  advanced?: { revision:string; session:string; shards:number; maxSessions:number };
}
let current: Manifest | undefined;
const ipoSnapshots = new Map<string, Promise<IPORow[]>>();

export interface ChartSnapshot {
  schemaVersion: number;
  symbol: string;
  asOfDate: string;
  historyStartDate: string | null;
  candles: Array<{date:string;open:number;high:number;low:number;close:number;volume:number}>;
  volumeEvents: Record<string, unknown>;
  corporateActions: Array<Record<string, unknown>>;
  earnings: Array<Record<string, unknown>>;
  regulatoryAnnouncements: Array<Record<string, unknown>>;
  marketNews: Array<Record<string, unknown>>;
}

async function getJson<T>(url: string, fresh = false): Promise<T> {
  const response = await fetch(url, fresh ? { cache:'no-store' } : undefined);
  if (!response.ok) throw new Error(`Dataset request failed (HTTP ${response.status})`);
  return response.json();
}

async function getChartJson<T>(url: string): Promise<T> {
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!bytes.length) throw new Error('Empty chart');
    let text: string;
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
      if (typeof DecompressionStream === 'undefined') throw new Error('Gzip unsupported');
      const stream = new Response(bytes).body!.pipeThrough(new DecompressionStream('gzip'));
      text = await new Response(stream).text();
    } else if (response.headers.get('Content-Encoding')?.toLowerCase() === 'gzip') {
      // Fetch has already decoded a CDN response with Content-Encoding: gzip.
      text = new TextDecoder().decode(bytes);
    } else {
      throw new Error('Expected a compressed chart');
    }
    const payload = JSON.parse(text);
    if (!payload || typeof payload !== 'object') throw new Error('Invalid chart');
    return payload as T;
  } catch {
    throw new Error('Chart data unavailable');
  }
}

async function getIpoJson<T>(url: string): Promise<T> {
  if (!url.endsWith('.gz')) return getJson<T>(url);
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!bytes.length || bytes[0] !== 0x1f || bytes[1] !== 0x8b) throw new Error('Expected gzip');
    if (typeof DecompressionStream === 'undefined') throw new Error('Gzip unsupported');
    const stream = new Response(bytes).body!.pipeThrough(new DecompressionStream('gzip'));
    return JSON.parse(await new Response(stream).text()) as T;
  } catch {
    throw new Error('IPO catalogue unavailable');
  }
}

function validateManifest(value: unknown): Manifest {
  const manifest = value as Manifest | null;
  const validUrl = (url: unknown) => typeof url === 'string' && !/\s/.test(url)
    && (/^\/(?!\/).+/.test(url) || /^https:\/\/[^/]+\/.+/.test(url));
  const validDate = (date: unknown) => typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)
    && !Number.isNaN(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date;
  const packNames = ['core','technical','fundamentals'] as const;
  const validPacks = manifest?.schemaVersion !== 7 || (manifest.packs && packNames.every(name => {
    const pack = manifest.packs![name];
    return pack?.schemaVersion === 7 && pack.encoding === 'gzip' && validUrl(pack.url)
      && Number.isInteger(pack.bytes) && pack.bytes > 0 && /^[a-f0-9]{64}$/.test(pack.sha256)
      && (pack.uncompressedBytes === undefined || (Number.isInteger(pack.uncompressedBytes) && pack.uncompressedBytes > 0
          && /^[a-f0-9]{64}$/.test(pack.uncompressedSha256 ?? '')));
  }));
  if (!manifest || !/^[a-f0-9]{64}$/.test(manifest.revision) || ![4, 5, 6, 7].includes(manifest.schemaVersion)
      || (manifest.datasetGzipUrl !== undefined && (!validUrl(manifest.datasetGzipUrl) || !manifest.datasetGzipUrl.endsWith('.json.gz')))
      || (manifest.earningsCalendarUrl !== undefined && (!validUrl(manifest.earningsCalendarUrl) || !manifest.earningsCalendarUrl.endsWith('.json.gz')))
      || !validDate(manifest.sessionDate) || !validUrl(manifest.datasetUrl) || !validUrl(manifest.iposUrl)
      || !Number.isInteger(manifest.totalStocks) || manifest.totalStocks < 0
      || (manifest.chartRevision !== undefined && !/^[a-f0-9]{64}$/.test(manifest.chartRevision))
      || !validPacks || (manifest.advanced !== undefined && (!manifest.advanced || manifest.advanced.revision !== manifest.revision
          || manifest.advanced.session !== manifest.sessionDate || manifest.advanced.shards !== 32))
      || (manifest.schemaVersion === 6 && !manifest.chartUrlTemplate)
      || (manifest.chartUrlTemplate !== undefined && (!validUrl(manifest.chartUrlTemplate)
          || manifest.chartUrlTemplate.split('{symbol}').length !== 2))) {
    throw new Error('Invalid scanner dataset manifest');
  }
  return manifest;
}

export async function refreshManifest(): Promise<Manifest> {
  const manifest = validateManifest(await getJson<unknown>('/data/current.json', true));
  current = manifest;
  return manifest;
}

async function snapshotSource(revision?: string): Promise<SnapshotSource> {
  const manifest = current ?? await refreshManifest();
  const selected = revision ?? manifest.revision;
  if (!/^[a-f0-9]{64}$/.test(selected)) throw new Error('Invalid dataset revision');
  // Older revisions retain their original JSON URL; current releases advertise gzip.
  return { revision:selected,
    url:selected === manifest.revision ? (typeof DecompressionStream !== 'undefined' ? manifest.datasetGzipUrl : undefined) ?? manifest.datasetUrl
      : `/data/revisions/${selected}/stocks.json`,
    sessionDate:selected === manifest.revision ? manifest.sessionDate : undefined,
    packs:selected === manifest.revision && manifest.schemaVersion === 7 && typeof DecompressionStream !== 'undefined' ? manifest.packs : undefined };
}

class RealDataAdapter {
  async getCatalog() { return NEXUS_CONDITION_CATALOG; }

  async explainScreen(_req: ExplainRequest): Promise<ExplainResponse> {
    return { isValid:true, errors:[], compiledExplanations:[], warnings:[] };
  }

  async runScreen(req: ScreenerRunRequest): Promise<ScreenerRunResponse> {
    const source = await snapshotSource(req.datasetRevision);
    const plan = expressionPlan(req.expressionTree,Boolean(req.textQuery?.trim()));
    if (plan.browser) {
      const snapshot = await runSnapshotTask({type:'screen',source,request:req});
      if (snapshot.type !== 'screen') throw new Error('Unexpected scanner response');
      if (snapshot.result) return snapshot.result;
    }
    const base = (import.meta.env.VITE_API_BASE_URL || '/api').replace(/\/$/, '');
    const manifest = current ?? await refreshManifest();
    if (!manifest.advanced && base !== '/api') throw new Error('This screen needs the advanced scanner data service.');
    const response = await fetch(`${base}/screens/run`, { method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({...req,asOfDate:source.sessionDate ?? req.asOfDate,datasetRevision:source.revision}) });
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.error) throw new Error(payload?.error || `Scanner request failed (HTTP ${response.status})`);
    if (payload?.immutableRevision !== source.revision || !Array.isArray(payload.rows)) throw new Error('Scanner returned a different dataset revision');
    return payload;
  }

  async getIpos(): Promise<IPORow[]> {
    const manifest = current ?? await refreshManifest();
    if (!ipoSnapshots.has(manifest.revision)) {
      const revision = manifest.revision;
      const promise = getIpoJson<Record<string, any> | {records:Record<string, any>[]}>(manifest.iposUrl).then(payload => {
        const rows: Record<string, any>[] = Array.isArray(payload) ? payload : payload.records;
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

  async getChart(symbol: string, revision?: string): Promise<ChartSnapshot> {
    const manifest = current ?? await refreshManifest();
    const selected = revision ?? manifest.revision;
    if (!/^[A-Z0-9&_-]+$/.test(symbol)) throw new Error('Invalid symbol');
    if (!/^[a-f0-9]{64}$/.test(selected)) throw new Error('Invalid dataset revision');
    const release = selected === manifest.revision ? manifest
      : validateManifest(await getJson<unknown>(`/data/revisions/${selected}/release.json`));
    if (release.revision !== selected || !release.chartUrlTemplate) throw new Error('Chart release unavailable');
    const url = release.chartUrlTemplate.replace('{symbol}', encodeURIComponent(symbol));
    const chart = await getChartJson<ChartSnapshot>(url);
    if (chart.symbol !== symbol || chart.asOfDate !== release.sessionDate) throw new Error('Chart session mismatch');
    return chart;
  }

  async compareSymbols(req: SymbolComparisonRequest): Promise<SymbolComparisonResponse> {
    const response = await runSnapshotTask({type:'compare',source:await snapshotSource(),symbols:req.symbols});
    if (response.type !== 'compare') throw new Error('Unexpected comparison response');
    return response.result;
  }

  async getCurrentRevision(): Promise<RevisionCurrentResponse> {
    const manifest = await refreshManifest();
    return {latestSessionDate:manifest.sessionDate,availableSessions:[{date:manifest.sessionDate,label:'Latest',isHistorical:false}],
      immutableRevision:manifest.revision,mainboardUniverseCount:manifest.totalStocks,catalogVersion:'v4-snapshot'};
  }
}

export const realAdapter = new RealDataAdapter();
