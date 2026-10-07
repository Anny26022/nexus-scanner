import type { ScreenerRunRequest, ScreenerRunResponse, IPORow, ExplainRequest, ExplainResponse,
  SymbolComparisonRequest, SymbolComparisonResponse, RevisionCurrentResponse } from '../types/screener';
import { NEXUS_CONDITION_CATALOG } from '../data/conditionCatalog';
import type { IpoCatalogue } from '../types/screener';
import { runSnapshotTask } from './snapshotClient';
import type { SnapshotSource } from './snapshotEngine';
import { filterAnnouncements, type Announcement, type AnnouncementCatalog, type AnnouncementIndex, type FilingTopic } from './announcements';

interface Manifest {
  revision: string;
  sessionDate: string;
  datasetUrl: string;
  datasetGzipUrl?: string;
  datasetPackedGzipUrl?: string;
  iposUrl: string;
  totalStocks: number;
  schemaVersion: number;
  chartUrlTemplate?: string;
  chartRevision?: string;
  dataIndexUrl?: string;
  objectUrlTemplate?: string;
}
let current: Manifest | undefined;
const ipoSnapshots = new Map<string, Promise<IpoCatalogue>>();

export interface ChartSnapshot {
  schemaVersion: number;
  symbol: string;
  asOfDate: string;
  historyStartDate: string | null;
  candles: Array<{date:string;open:number;high:number;low:number;close:number;volume:number}>;
  volumeEvents: Record<string, unknown>;
  corporateActions: Array<Record<string, unknown>>;
  earnings: Array<Record<string, unknown>>;
  regulatoryAnnouncements?: Array<Record<string, unknown>>;
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

// Content-addressed URLs survive release changes. Share pending reads and parsed data.
const objectCache = new Map<string, Promise<unknown>>();
const releaseCache = new Map<string, Promise<unknown>>();
function cached<T>(cache: Map<string, Promise<unknown>>, key: string, load: () => Promise<T>, limit: number): Promise<T> {
  let promise = cache.get(key);
  if (!promise) {
    promise = load().catch(error => {
      if (cache.get(key) === promise) cache.delete(key);
      throw error;
    });
    cache.set(key, promise);
    if (cache.size > limit) cache.delete(cache.keys().next().value!);
  }
  return promise as Promise<T>;
}
interface DataIndex { revision: string; asOfDate: string; chartObjects: Record<string, string>; announcements: string }
async function releaseFor(revision?: string): Promise<Manifest> {
  const latest = current ?? await refreshManifest();
  const selected = revision ?? latest.revision;
  if (!/^[a-f0-9]{64}$/.test(selected)) throw new Error('Invalid dataset revision');
  const release = selected === latest.revision ? latest : validateManifest(await cached(
    releaseCache, selected, () => getJson<unknown>(`/data/revisions/${selected}/release.json`), 3));
  if (release.revision !== selected) throw new Error('Release revision mismatch');
  return release;
}
async function dataIndex(release: Manifest): Promise<DataIndex> {
  if (!release.dataIndexUrl) throw new Error('Announcements are unavailable in this release');
  const index = await cached(releaseCache, release.dataIndexUrl, () => getJson<DataIndex>(release.dataIndexUrl!), 6);
  if (index.asOfDate !== release.sessionDate || index.revision !== release.chartRevision) throw new Error('Data index release mismatch');
  return index;
}
async function object<T>(release: Manifest, hash: string): Promise<T> {
  if (!release.objectUrlTemplate || !/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid data object reference');
  const url = release.objectUrlTemplate.replace('{hash}', hash);
  return cached(objectCache, url, () => getChartJson<T>(url), 32);
}
function validSymbol(symbol: string) {
  if (!/^[A-Z0-9&_-]+$/.test(symbol)) throw new Error('Invalid symbol');
}
async function announcementCatalog(release: Manifest): Promise<AnnouncementCatalog> {
  const index = await dataIndex(release);
  const catalog = await object<AnnouncementCatalog>(release, index.announcements);
  if (catalog.referenceSession !== release.sessionDate) throw new Error('Announcement release mismatch');
  return catalog;
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
  if (!manifest || !/^[a-f0-9]{64}$/.test(manifest.revision) || ![4, 5, 6, 7].includes(manifest.schemaVersion)
      || (manifest.datasetGzipUrl !== undefined && (!validUrl(manifest.datasetGzipUrl) || !manifest.datasetGzipUrl.endsWith('.json.gz')))
      || (manifest.datasetPackedGzipUrl !== undefined && (!validUrl(manifest.datasetPackedGzipUrl) || !manifest.datasetPackedGzipUrl.endsWith('.json.gz')))
      || !validDate(manifest.sessionDate) || !validUrl(manifest.datasetUrl) || !validUrl(manifest.iposUrl)
      || !Number.isInteger(manifest.totalStocks) || manifest.totalStocks < 0
      || (manifest.chartRevision !== undefined && !/^[a-f0-9]{64}$/.test(manifest.chartRevision))
      || (manifest.schemaVersion === 6 && !manifest.chartUrlTemplate)
      || (manifest.schemaVersion === 7 && (!validUrl(manifest.dataIndexUrl) || !manifest.chartRevision
          || !validUrl(manifest.objectUrlTemplate) || manifest.objectUrlTemplate?.split('{hash}').length !== 2))
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
    url:selected === manifest.revision ? (typeof DecompressionStream !== 'undefined' ? manifest.datasetPackedGzipUrl ?? manifest.datasetGzipUrl : undefined) ?? manifest.datasetUrl
      : `/data/revisions/${selected}/stocks.json`,
    sessionDate:selected === manifest.revision ? manifest.sessionDate : undefined };
}

class RealDataAdapter {
  async getCatalog() { return NEXUS_CONDITION_CATALOG; }

  async explainScreen(_req: ExplainRequest): Promise<ExplainResponse> {
    return { isValid:true, errors:[], compiledExplanations:[], warnings:[] };
  }

  async runScreen(req: ScreenerRunRequest): Promise<ScreenerRunResponse> {
    const announcementFilter = req.announcementFilter;
    if (announcementFilter) {
      const release = await releaseFor(req.datasetRevision);
      req = {...req, datasetRevision: release.revision};
      const index = await this.getAnnouncementIndex(req.datasetRevision);
      const matches = filterAnnouncements(index, announcementFilter);
      req = {...req, announcementSymbols: [...new Set(matches.map(row => row.symbol!))]};
    }
    const source = await snapshotSource(req.datasetRevision);
    const snapshot = req.textQuery?.trim()
      ? {type:'screen' as const, source, revision:source.revision, sessionDate:source.sessionDate ?? req.asOfDate, result:null}
      : await runSnapshotTask({type:'screen',source,request:req});
    if (snapshot.type !== 'screen') throw new Error('Unexpected scanner response');
    if (snapshot.result) return snapshot.result;
    const base = (import.meta.env.VITE_API_BASE_URL || '/api').replace(/\/$/, '');
    const response = await fetch(`${base}/screens/run`, { method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({...req,asOfDate:snapshot.sessionDate,datasetRevision:snapshot.revision}) });
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.error) throw new Error(payload?.error || `Scanner request failed (HTTP ${response.status})`);
    if (payload?.immutableRevision !== snapshot.revision || !Array.isArray(payload.rows)) throw new Error('Scanner returned a different dataset revision');
    return payload;
  }

  async getIpos(): Promise<IPORow[]> {
    return (await this.getIpoCatalogue()).records;
  }

  async getIpoCatalogue(): Promise<IpoCatalogue> {
    const manifest = current ?? await refreshManifest();
    if (!ipoSnapshots.has(manifest.revision)) {
      const revision = manifest.revision;
      const promise = getIpoJson<Record<string, any> | {records:Record<string, any>[]}>(manifest.iposUrl).then(payload => {
        const rows: Record<string, any>[] = Array.isArray(payload) ? payload : payload.records;
        const details = 'provider_data' in payload ? payload.provider_data?.details : undefined;
        const records = rows.map(r => {
          const detail = r.provider?.id ? details?.[r.provider.id] : undefined;
          const timestamp = detail?.fetched_at;
          const lastSuccessAt = typeof timestamp === 'string' && Number.isFinite(Date.parse(timestamp)) ? timestamp : null;
          // Show endpoint names, never provider request/credential diagnostics.
          const failedEndpoints = Array.isArray(detail?.errors)
            ? [...new Set<string>(detail.errors.filter((error: unknown) => typeof error === 'string')
                .map((error: string) => error.split(':', 1)[0]).map((name: string) => /^[a-z_]+$/.test(name) ? name : 'unknown'))]
            : [];
          return {
            symbol:r.symbol, name:r.name || r.company_name || '', listingDate:r.listing_date || '',
            currentPrice:r.close ?? 0, turnoverCrore:r.rupee_volume == null ? 0 : r.rupee_volume / 10_000_000,
            deliveryPct:r.delivery_percent ?? null,
            sector:r.sector || 'Unclassified', industry:r.industry || 'Unclassified', marketCapCrore:r.market_cap_crore ?? 0,
            ipoDetailStatus: r.provider?.id ? {lastSuccessAt, failedEndpoints} : undefined,
          };
        });
        const provider = 'provider_data' in payload ? payload.provider_data : undefined;
        return {records, providerStatus: provider ? {
          checkedAt: typeof provider.fetched_at === 'string' && Number.isFinite(Date.parse(provider.fetched_at)) ? provider.fetched_at : null,
          state: provider.refresh_complete === true ? 'complete' as const
            : provider.refresh_complete == null ? 'unknown' as const
            : Object.keys(provider.feeds ?? {}).length || Object.keys(provider.analytics ?? {}).length ? 'partial' as const
            : provider.available === false ? 'unavailable' as const : 'retained' as const,
        } : undefined};
      }).catch(error => { ipoSnapshots.delete(revision); throw error; });
      ipoSnapshots.set(revision,promise);
      if (ipoSnapshots.size > 3) ipoSnapshots.delete(ipoSnapshots.keys().next().value!);
    }
    return ipoSnapshots.get(manifest.revision)!;
  }

  async getChart(symbol: string, revision?: string): Promise<ChartSnapshot> {
    validSymbol(symbol);
    const release = await releaseFor(revision);
    if (release.schemaVersion === 7) {
      const index = await dataIndex(release);
      const chart = await object<ChartSnapshot>(release, index.chartObjects[symbol]);
      if (chart.symbol !== symbol || chart.schemaVersion !== 2) throw new Error('Chart symbol/schema mismatch');
      return {...chart, asOfDate: release.sessionDate};
    }
    if (!release.chartUrlTemplate) throw new Error('Chart release unavailable');
    const url = release.chartUrlTemplate.replace('{symbol}', encodeURIComponent(symbol));
    const chart = await cached(objectCache, url, () => getChartJson<ChartSnapshot>(url), 32);
    if (chart.symbol !== symbol || chart.asOfDate !== release.sessionDate) throw new Error('Chart session mismatch');
    return chart;
  }

  async getAnnouncementIndex(revision?: string): Promise<AnnouncementIndex> {
    const release = await releaseFor(revision);
    const catalog = await announcementCatalog(release);
    const index = await object<AnnouncementIndex>(release, catalog.index);
    if (index.referenceSession !== release.sessionDate || index.publishedAt !== catalog.publishedAt) throw new Error('Announcement index mismatch');
    return index;
  }

  async getAnnouncementTopics(revision?: string): Promise<FilingTopic[]> {
    const release = await releaseFor(revision);
    const catalog = await announcementCatalog(release);
    return (await object<{topics: FilingTopic[]}>(release, catalog.taxonomy)).topics;
  }

  async getAnnouncements(symbol: string, revision?: string): Promise<{records: Announcement[]; years: number[]; publishedAt: string}> {
    validSymbol(symbol);
    const release = await releaseFor(revision);
    const catalog = await announcementCatalog(release);
    const entry = catalog.symbols[symbol];
    if (!entry) throw new Error('Announcement history unavailable for this symbol');
    const recent = await object<{symbol: string; records: Announcement[]}>(release, entry.recent);
    if (recent.symbol !== symbol) throw new Error('Announcement symbol mismatch');
    return {...recent, years: Object.keys(entry.years).map(Number).sort((a, b) => b - a), publishedAt: catalog.publishedAt};
  }

  async getAnnouncementHistory(symbol: string, year: number, page = 0, revision?: string): Promise<{records: Announcement[]; pages: number}> {
    validSymbol(symbol);
    const release = await releaseFor(revision);
    const catalog = await announcementCatalog(release);
    const pages = catalog.symbols[symbol]?.years[String(year)];
    if (!Number.isInteger(page) || page < 0 || !pages?.[page]) throw new Error('Announcement page unavailable');
    const result = await object<{symbol: string; records: Announcement[]}>(release, pages[pages.length - 1 - page].summary);
    if (result.symbol !== symbol) throw new Error('Announcement symbol mismatch');
    return {records: [...result.records].reverse(), pages: pages.length};
  }

  async getAnnouncementDetail(symbol: string, row: Announcement, revision?: string): Promise<Record<string, unknown>> {
    validSymbol(symbol);
    const release = await releaseFor(revision);
    const catalog = await announcementCatalog(release);
    const allowed = Object.values(catalog.symbols[symbol]?.years ?? {}).flat().some(page => page.details === row.detailPage);
    if (!allowed) throw new Error('Filing is not part of this release');
    const details = await object<{symbol: string; records: Record<string, Record<string, unknown>>}>(release, row.detailPage);
    if (details.symbol !== symbol || !details.records[row.id]) throw new Error('Filing detail unavailable');
    return details.records[row.id];
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
