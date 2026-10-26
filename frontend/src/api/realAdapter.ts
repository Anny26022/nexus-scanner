import { getIpoJson } from './gzipJson';
import type { ScreenerRunRequest, ScreenerRunResponse, IPORow, ExplainRequest, ExplainResponse,
  StockRow, SymbolComparisonRequest, SymbolComparisonResponse, RevisionCurrentResponse } from '../types/screener';
import { NEXUS_CONDITION_CATALOG } from '../data/conditionCatalog';
import type { IpoCatalogue } from '../types/screener';
import { runSnapshotTask } from './snapshotClient';
import type { SnapshotSource } from './snapshotEngine';
import { filterAnnouncements, type Announcement, type AnnouncementCatalog, type AnnouncementIndex, type FilingTopic } from './announcements';
import { DataUnavailableError } from './dataErrors';
import { getManifest, refreshManifest, validateManifest, validDate, manifestSnapshotSource, resolveManifestUrls, type Manifest } from './manifest';
import { dataUrl } from './origins';
import { parseMarketOverview } from '../utils/marketOverview';
import type { RotationIndex, RotationShard, RotationShardName } from './rotation';
export { refreshManifest } from './manifest';
const ipoSnapshots = new Map<string, Promise<IpoCatalogue>>();
const finiteAmount = (value: unknown): number | null => {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

export type ChartRow = Pick<StockRow, 'symbol' | 'name' | 'close' | 'changePct' | 'marketCapCrore' | 'freeFloatPct' | 'circuitLimit' | 'series' | 'sector' | 'industry' | 'nicheTags' | 'isFno' | 'surveillanceAvailable' | 'surveillanceAsOfDate' | 'isAsm' | 'asmStage' | 'isGsm' | 'gsmStage' | 'listingDate'>;

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

async function getJson<T>(url: string, fresh = false, resource = 'Dataset'): Promise<T> {
  const response = await fetch(url, fresh ? { cache:'no-store' } : undefined);
  if (!response.ok) throw new DataUnavailableError(`${resource} request failed (HTTP ${response.status})`, response.status === 404 ? 'not_found' : 'download_failed');
  try { return await response.json(); }
  catch (error) {
    if (error instanceof SyntaxError) throw new DataUnavailableError(`${resource} file is missing or invalid. The host may be returning a page instead of data.`, 'not_found');
    throw new DataUnavailableError(`${resource} download failed. Please retry.`, 'download_failed');
  }
}

async function getChartJson<T>(url: string, resource = 'Chart'): Promise<T> {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      if (resource === 'Announcement') throw new DataUnavailableError(response.status === 404
        ? 'The announcement file is missing from this published release. Please report this deployment issue.'
        : `Announcement download failed (HTTP ${response.status}). Please retry.`, response.status === 404 ? 'not_found' : 'download_failed');
      throw new Error(`HTTP ${response.status}`);
    }
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
  } catch (error) {
    if (error instanceof DataUnavailableError) throw error;
    if (resource === 'Announcement') throw new DataUnavailableError('Announcement data could not be downloaded or decoded. Please retry; if this persists, check the release files and storage access.', 'download_failed');
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
interface FilingLookup {
  publishedAt: string; taxonomy: string; index: string;
  symbols: Record<string, {recent: string; years: number[]; history: string; fetchStatus?: Record<string, unknown>}>;
}
interface DataIndex {
  revision: string; asOfDate: string; chartObjects: Record<string, string>; announcements: string;
  /** Each chart's candle chunks, so the record and candles can load together (newer releases). */
  chartChunks?: Record<string, string[]>;
  /** Inline in older releases; newer ones keep it in its own object to keep this index small. */
  filingLookup?: FilingLookup; filingLookupObject?: string;
}
async function releaseFor(revision?: string): Promise<Manifest> {
  const latest = await getManifest();
  const selected = revision ?? latest.revision;
  if (!/^[a-f0-9]{64}$/.test(selected)) throw new Error('Invalid dataset revision');
  if (selected === latest.revision) return latest;
  try {
    const release = resolveManifestUrls(validateManifest(await cached(
      releaseCache, selected, () => getJson<unknown>(dataUrl(`/data/revisions/${selected}/release.json`)), 3)));
    if (release.revision !== selected) throw new Error('Release revision mismatch');
    return release;
  } catch (err) {
    console.warn(`Release manifest for revision ${selected} not found, falling back to latest release:`, err);
    return latest;
  }
}
async function dataIndex(release: Manifest): Promise<DataIndex> {
  if (!release.dataIndexUrl) throw new DataUnavailableError('Announcements were not published with this data release. The publisher must configure announcement storage and publish a complete release.', 'not_published');
  const index = await cached(releaseCache, release.dataIndexUrl, () => getJson<DataIndex>(release.dataIndexUrl!, false, 'Announcement index'), 6);
  if (index.asOfDate !== release.sessionDate || index.revision !== release.chartRevision) throw new Error('Data index release mismatch');
  return index;
}
async function object<T>(release: Manifest, hash: string, resource = 'Announcement'): Promise<T> {
  if (!release.objectUrlTemplate || !/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid data object reference');
  const url = release.objectUrlTemplate.replace('{hash}', hash);
  return cached(objectCache, url, () => getChartJson<T>(url, resource), 128);
}
/**
 * Where the release's rotation history lives: its index hash and a URL template for its files. In the dev
 * server only, a release without one falls back to tools/build_rotation_local.py's local.json pointer.
 */
async function rotationSource(release: Manifest): Promise<{index: string; template: string} | null> {
  if (release.rotationHistoryObject && release.rotationUrlTemplate) return {index: release.rotationHistoryObject, template: release.rotationUrlTemplate};
  if (!import.meta.env.DEV) return null;
  const local = await fetch('/data/rotation/local.json', {cache: 'no-cache'}).then(response => response.ok ? response.json() : null).catch(() => null);
  return local && /^[a-f0-9]{64}$/.test(local.index) && local.sessionDate === release.sessionDate
    ? {index: local.index, template: '/data/rotation/{hash}.json.gz'} : null;
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

async function filingLookup(release: Manifest): Promise<FilingLookup | undefined> {
  const index = await dataIndex(release);
  return index.filingLookup ?? (index.filingLookupObject ? object<FilingLookup>(release, index.filingLookupObject) : undefined);
}

async function announcementReferences(release: Manifest) {
  return (await filingLookup(release)) ?? announcementCatalog(release);
}

async function companyAnnouncements(release: Manifest, symbol: string) {
  const lookup = await filingLookup(release);
  if (!lookup) return (await announcementCatalog(release)).symbols[symbol];
  const entry = lookup.symbols[symbol];
  if (!entry) throw new Error('Announcement history unavailable for this symbol');
  const history = await object<AnnouncementCatalog['symbols'][string] & {symbol: string}>(release, entry.history);
  if (history.symbol !== symbol || history.recent !== entry.recent) throw new Error('Announcement history mismatch');
  return history;
}


async function snapshotSource(revision?: string, sessionDate?: string, etf = false): Promise<SnapshotSource> {
  return manifestSnapshotSource(await getManifest(), revision, sessionDate, etf);
}

class RealDataAdapter {
  async getChartRows(revision?: string, sessionDate?: string): Promise<ChartRow[]> {
    const release = await releaseFor(revision);
    if (revision && release.revision !== revision) throw new Error('Chart directory revision mismatch');
    if (!release.chartDirectoryUrl || (sessionDate && sessionDate !== release.sessionDate)) {
      const result = await this.runScreen({datasetRevision:release.revision, universe:'mainboard',
        asOfDate:sessionDate ?? release.sessionDate, page:1, pageSize:100,
        sort:{field:'marketCap',direction:'desc'}, expressionTree:{type:'group',operator:'all',children:[]}}, true);
      if (result.immutableRevision !== release.revision) throw new Error('Chart directory revision mismatch');
      return result.rows;
    }
    const data = await cached(releaseCache, release.chartDirectoryUrl,
      () => getIpoJson<{revision:string;asOfDate:string;stocks:ChartRow[]}>(release.chartDirectoryUrl!, 'Chart directory'), 6);
    if (data.revision !== release.revision || data.asOfDate !== release.sessionDate || !Array.isArray(data.stocks)
        || data.stocks.length !== release.totalStocks || data.stocks.some(row => !row || typeof row.symbol !== 'string')
        || new Set(data.stocks.map(row => row.symbol)).size !== data.stocks.length) throw new Error('Invalid chart directory');
    return data.stocks.filter(row => Number.isFinite(row.close))
      .sort((a,b) => b.marketCapCrore - a.marketCapCrore || a.symbol.localeCompare(b.symbol));
  }

  async getFinancialHistory(symbol: string, revision: string) {
    const release = await releaseFor(revision);
    validSymbol(symbol);
    if (release.revision !== revision || (!release.financialHistoryUrl && !release.financialHistoryUrlTemplate)) throw new Error('Financial history was not published with this snapshot.');
    if (release.financialHistoryUrlTemplate) return getIpoJson<import('../chart/fundamentals').FinancialHistory | null>(release.financialHistoryUrlTemplate.replace('{symbol}', encodeURIComponent(symbol)), 'Financial history');
    const result = await runSnapshotTask({type:'financialHistory', source:{revision, url:release.financialHistoryUrl!}, symbol});
    if (result.type !== 'financialHistory') throw new Error('Unexpected financial history response');
    return result.result;
  }
  async getEarningsSchedule(symbol: string, revision: string) {
    const release = await releaseFor(revision);
    if (release.revision !== revision || !release.earningsCalendarUrl) return null;
    const calendar = await cached(releaseCache, release.earningsCalendarUrl,
      () => getIpoJson<{fetched_at: string; events: Array<{symbol: string; scheduled_date: string; date_conflict?: boolean}>}>(release.earningsCalendarUrl!, 'Earnings calendar'), 3);
    return {observedOn: calendar.fetched_at?.slice(0, 10), events: calendar.events.filter(event => event.symbol === symbol)};
  }

  /** This symbol's dated bands ([date, band] pairs, first = starting band), or null when the release has none. */
  async getPriceBandHistory(symbol: string, revision: string) {
    const release = await releaseFor(revision);
    if (release.revision !== revision) return null;
    type Ledger = {version: number; from: string; through: string; bands: Record<string, Array<[string, string]>>};
    // Releases published before the ledger existed fall back to the committed ledger file.
    const url = release.priceBandHistoryUrl ?? dataUrl('/data/price-band-history.json');
    const ledger = await cached(releaseCache, url, async () => {
      if (release.priceBandHistoryUrl) return getIpoJson<Ledger>(url, 'Price-band history');
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Price-band history unavailable (HTTP ${response.status})`);
      return response.json() as Promise<Ledger>;
    }, 3).catch(() => null);
    if (!ledger) return null;
    if (ledger.version !== 1) return null;
    return {from: ledger.from, through: ledger.through, bands: ledger.bands[symbol] ?? []};
  }

  async getThemeClassification(revision?: string) {
    const release = await releaseFor(revision);
    if (!release.themeClassificationUrl || !release.themeClassificationVersion) throw new Error('Theme classifications are unavailable in this release.');
    const data = await cached(releaseCache, release.themeClassificationUrl,
      () => getIpoJson<import('../utils/copyResults').ThemeClassification>(release.themeClassificationUrl!, 'Theme classification'), 6);
    if (data.schemaVersion !== 1 || data.version !== release.themeClassificationVersion || data.asOfDate !== release.sessionDate || !data.records) {
      throw new Error('Theme classification release mismatch');
    }
    return data;
  }
  /** The Rotation page's price-history index, or null when the release did not publish one. */
  async getRotationIndex(revision?: string): Promise<RotationIndex | null> {
    const release = await releaseFor(revision);
    const source = await rotationSource(release);
    if (!source) return null;
    const url = source.template.replace('{hash}', source.index);
    const index = await cached(objectCache, url, () => getChartJson<RotationIndex>(url, 'Rotation history'), 128);
    if (index.schemaVersion !== 1 || index.asOfDate !== release.sessionDate) throw new Error('Rotation history release mismatch');
    return index;
  }
  async getRotationShard(revision: string | undefined, name: RotationShardName): Promise<RotationShard> {
    const release = await releaseFor(revision);
    const [source, index] = await Promise.all([rotationSource(release), this.getRotationIndex(revision)]);
    const hash = index?.shards[name];
    if (!source || !hash || !/^[a-f0-9]{64}$/.test(hash)) throw new Error('Rotation history is unavailable in this release.');
    const url = source.template.replace('{hash}', hash);
    const shard = await cached(objectCache, url, () => getChartJson<RotationShard>(url, 'Rotation history'), 128);
    if (shard.schemaVersion !== 1 || shard.shard !== name || shard.asOfDate !== index!.asOfDate) throw new Error('Rotation history shard mismatch');
    return shard;
  }
  /** Nifty 50 closes by session date, or undefined when the release has no benchmark. */
  async getBenchmark(revision?: string): Promise<ReadonlyMap<string, number> | undefined> {
    const release = await releaseFor(revision);
    if (!release.benchmarkUrl) return undefined;
    const data = await cached(releaseCache, release.benchmarkUrl,
      () => getIpoJson<{schemaVersion?: number; asOfDate?: string; records?: unknown}>(release.benchmarkUrl!, 'Benchmark'), 6);
    if (data.schemaVersion !== 1 || data.asOfDate !== release.sessionDate || !Array.isArray(data.records)) throw new Error('Benchmark release mismatch');
    return new Map(data.records.filter((row): row is [string, number] => Array.isArray(row) && typeof row[0] === 'string'
      && /^\d{4}-\d{2}-\d{2}$/.test(row[0]) && row[0] <= release.sessionDate && typeof row[1] === 'number' && Number.isFinite(row[1]) && row[1] > 0));
  }
  /** Compact per-stock rows for the Market page, from the release's scanner snapshot. */
  async getMarketPulse(revision?: string) {
    const source = await snapshotSource(revision);
    const result = await runSnapshotTask({type:'marketPulse', source});
    if (result.type !== 'marketPulse' || result.revision !== source.revision) throw new Error('Market pulse release mismatch');
    return {rows: result.result, sessionDate: result.sessionDate};
  }
  async getMarketOverview(revision?: string) {
    const release = await releaseFor(revision);
    if (!release.marketOverviewUrl) throw new DataUnavailableError('Market overview is published with the next data refresh.', 'not_published');
    const data = await cached(releaseCache, release.marketOverviewUrl,
      () => getIpoJson<unknown>(release.marketOverviewUrl!, 'Market overview'), 6);
    return parseMarketOverview(data, release.sessionDate);
  }
  async getFilterChoices(revision?: string, sessionDate?: string, etf = false) {
    const response = await runSnapshotTask({type:'filterChoices',source:await snapshotSource(revision, sessionDate, etf)});
    if (response.type !== 'filterChoices') throw new Error('Unexpected filter choices response');
    return response.result;
  }
  async getCatalog() { return NEXUS_CONDITION_CATALOG; }

  async explainScreen(_req: ExplainRequest): Promise<ExplainResponse> {
    return { isValid:true, errors:[], compiledExplanations:[], warnings:[] };
  }

  async runScreen(req: ScreenerRunRequest, allRows = false): Promise<ScreenerRunResponse> {
    if (req.universe === 'etf' && (req.textQuery?.trim() || req.announcementFilter)) throw new Error('Use the ETF filters to build this screen.');
    const announcementFilter = req.announcementFilter;
    if (announcementFilter) {
      const release = await releaseFor(req.datasetRevision);
      req = {...req, datasetRevision: release.revision};
      const index = await this.getAnnouncementIndex(req.datasetRevision);
      const matches = filterAnnouncements(index, announcementFilter);
      req = {...req, announcementSymbols: [...new Set(matches.map(row => row.symbol!))]};
    }
    const source = await snapshotSource(req.datasetRevision, req.asOfDate, req.universe === 'etf');

    const snapshot = req.textQuery?.trim()
      ? {type:'screen' as const, source, revision:source.revision, sessionDate:source.sessionDate ?? req.asOfDate, result:null}
      : await runSnapshotTask({type:'screen',source,request:req,allRows});
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
    const manifest = await getManifest();
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
          const detailData = detail?.data ?? {};
          const endpointNames = Object.keys(detailData).filter(name => /^[a-z_]+$/.test(name));
          const decodedIssue = detailData.issue?.ipo;
          return {
            symbol:r.symbol, name:r.name || r.company_name || '', listingDate:r.listing_date || '',
            isin: r.isin ?? undefined,
            securityId: r.security_id ?? undefined,
            listingAgeCalendarDays: finiteAmount(r.listing_age_calendar_days),
            anchorLockInEnd: r.anchor_lock_in_end ?? null,
            nextAnchorLockInDate: r.next_anchor_lock_in_date ?? null,
            anchorLockInCalendar: Array.isArray(r.anchor_lock_in_calendar) ? r.anchor_lock_in_calendar.map((item: any) => ({
              listingDate: item.listing_date ?? null,
              unlockDate: item.unlock_date ?? null,
              tranche: finiteAmount(item.tranche),
            })) : null,
            currentPrice:r.close ?? 0, turnoverCrore:r.rupee_volume == null ? 0 : r.rupee_volume / 10_000_000,
            deliveryPct:r.delivery_percent ?? null,
            sector:r.sector || 'Unclassified', industry:r.industry || 'Unclassified', marketCapCrore:r.market_cap_crore ?? 0,
            ipoDetailStatus: r.provider?.id ? {lastSuccessAt, failedEndpoints} : undefined,
            ipoResearch: {
              issuePrice: r.issue_price ?? null,
              offer: r.offer_structure ? {
                issueSizeCrore: r.offer_structure.issue_size_crore ?? null,
                freshIssueCrore: r.offer_structure.fresh_issue_crore ?? null,
                offerForSaleCrore: r.offer_structure.offer_for_sale_crore ?? null,
              } : undefined,
              subscription: {
                total: r.provider?.total_subscription_multiple ?? null,
                retail: r.retail_subscription_multiple ?? null,
                nii: r.provider?.nii_subscription_multiple ?? null,
                institutional: r.institutional_subscription_multiple ?? null,
              },
              provider: {
                listingPrice: r.provider?.listing_price ?? null,
                listingGainPct: r.provider?.listing_gain_percent ?? null,
                gmp: r.provider?.gmp ?? null,
                gmpPct: r.provider?.gmp_percent ?? null,
              },
              issueDetail: r.provider?.id ? {
                fetchedAt: lastSuccessAt,
                endpoints: endpointNames,
                registrar: detailData.allotment?.registrar ?? detailData.allotment_check?.registrar ?? decodedIssue?.registrar ?? null,
                allotmentStatus: detailData.allotment?.status ?? detailData.allotment_check?.status ?? null,
                allotmentDate: detailData.allotment?.allotment_date ?? null,
                refundDate: detailData.allotment?.refund_date ?? null,
                dematCreditDate: detailData.allotment?.demat_credit_date ?? null,
                documentCount: Array.isArray(detailData.documents?.documents) ? detailData.documents.documents.length : detailData.documents?.count ?? null,
                timelineStatus: detailData.timeline?.status ?? null,
                issue: decodedIssue ? {
                  priceBandLow: decodedIssue.price_band_low ?? null,
                  priceBandHigh: decodedIssue.price_band_high ?? null,
                  lotSize: decodedIssue.lot_size ?? null,
                  minInvestment: decodedIssue.min_investment ?? null,
                  leadManagers: decodedIssue.lead_managers ?? null,
                  totalApplications: decodedIssue.total_applications ?? null,
                  revenueCrore: decodedIssue.revenue_cr ?? null,
                  profitCrore: decodedIssue.pat_cr ?? null,
                  roePct: decodedIssue.ronw_pct ?? null,
                  peAtUpper: decodedIssue.pe_at_upper ?? null,
                  about: decodedIssue.about ?? null,
                  qualityGrade: decodedIssue.quality_grade ?? null,
                  issueType: decodedIssue.ipo_type ?? null,
                } : undefined,
                gmpHistory: Array.isArray(detailData.gmp_history) ? detailData.gmp_history.map((item: any) => ({date: item.ts, gmp: item.gmp ?? null, gmpPct: item.gmp_pct ?? null})) : [],
                documents: Array.isArray(detailData.documents?.documents) ? detailData.documents.documents.map((item: any) => ({label: item.label, kind: item.kind, url: item.url, note: item.note})) : [],
                valuation: detailData.prospectus?.valuation ? {
                  pe: detailData.prospectus.valuation.pe ?? null,
                  pb: detailData.prospectus.valuation.pb ?? null,
                  evEbitda: detailData.prospectus.valuation.ev_ebitda ?? null,
                  peerMedianPe: detailData.prospectus.valuation.peer_median_pe ?? null,
                  verdict: detailData.prospectus.valuation.verdict ?? null,
                } : undefined,
                peerAvailability: detailData.peer_valuation ? {available: detailData.peer_valuation.available, reason: detailData.peer_valuation.reason ?? null} : undefined,
              } : undefined,
              profile: r.profile ? {
                offer: r.profile.listed ? {
                  floorPrice: r.profile.details?.floor_price ?? null,
                  ceilingPrice: r.profile.details?.ceiling_price ?? null,
                  lotSize: r.profile.details?.trading_lot ?? null,
                  startDate: r.profile.listed.ipo_start_date ?? null,
                  endDate: r.profile.listed.ipo_end_date ?? null,
                } : undefined,
                issueSize: r.profile.details?.issue_size ?? null,
                allotmentDate: r.profile.details?.allotment_date ?? null,
                companyDetail: r.profile.details?.company_detail ?? null,
                financials: Array.isArray(r.profile.details?.financials) ? r.profile.details.financials.map((item: any) => ({
                  date: item.date, unit: item.unit,
                  revenue: finiteAmount(item.pl?.revenue_from_operations ?? item.pl?.total_revenue),
                  profit: finiteAmount(item.pl?.total_profit),
                })) : [],
                purpose: Array.isArray(r.profile.details?.ipoPurpose) ? r.profile.details.ipoPurpose.map((item: any) => ({
                  title: item.title, description: item.description, amount: item.total_amount, unit: item.unit,
                })) : [],
                strengths: Array.isArray(r.profile.details?.strengths) ? r.profile.details.strengths.map((item: any) => ({title: item.title, description: item.description})) : [],
                risks: Array.isArray(r.profile.details?.riskFactors) ? r.profile.details.riskFactors.map((item: any) => ({title: item.title, description: item.description})) : [],
                management: Array.isArray(r.profile.details?.managementTeam) ? r.profile.details.managementTeam.map((item: any) => ({name: item.name, designation: item.designation})) : [],
                drhpUrl: r.profile.details?.drhp_doc ?? r.profile.details?.sym_doc_url ?? null,
              } : undefined,
              conflicts: Array.isArray(r.enrichment_conflicts) ? r.enrichment_conflicts
                .filter((item: any) => typeof item?.field === 'string')
                .map((item: any) => ({field: item.field, provider: item.provider ?? null, secondary: item.profile ?? null})) : [],
            },
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

  async getChart(symbol: string, revision?: string, sessionDate?: string): Promise<ChartSnapshot> {
    if (sessionDate && !validDate(sessionDate)) throw new Error('Invalid chart session date');
    const chart = await this.publishedChart(symbol, revision);
    const cutoff = sessionDate && sessionDate < chart.asOfDate ? sessionDate : chart.asOfDate;
    const candles = chart.candles.filter(candle => candle.date <= cutoff);
    const clipped = {...chart, asOfDate: cutoff, candles};
    if (cutoff < chart.asOfDate) {
      clipped.historyStartDate = candles[0]?.date ?? null;
      clipped.volumeEvents = {}; // Release-wide extremes can include future candles.
      for (const [field, dateKey] of [['corporateActions', 'ex_date'], ['earnings', 'filing_date'],
        ['marketNews', 'date'], ['regulatoryAnnouncements', 'date']] as const) {
        clipped[field] = (chart[field] ?? []).filter(row => typeof row[dateKey] === 'string'
          && (row[dateKey] as string).slice(0, 10) <= cutoff);
      }
    }
    return clipped;
  }

  private async publishedChart(symbol: string, revision?: string): Promise<ChartSnapshot> {
    validSymbol(symbol);
    const release = await releaseFor(revision);
    if (release.schemaVersion === 7) {
      const index = await dataIndex(release);
      type Chunk = {schemaVersion:number;symbol:string;candles:ChartSnapshot['candles']};
      // When the index lists the candle chunks, fetch them alongside the record rather than after it.
      const listed = index.chartChunks?.[symbol];
      const early = Array.isArray(listed) && listed.length <= 2 ? listed.map(hash => object<Chunk>(release, hash, 'Chart')) : null;
      early?.forEach(request => request.catch(() => undefined)); // a failure surfaces through the record path below
      const chart = await object<ChartSnapshot & {candleChunks?: string[]}>(release, index.chartObjects[symbol], 'Chart');
      if (chart.symbol !== symbol || ![2, 3].includes(chart.schemaVersion)) throw new Error('Chart symbol/schema mismatch');
      if (chart.schemaVersion === 3) {
        const {candleChunks, ...metadata} = chart;
        if (!Array.isArray(candleChunks) || candleChunks.length > 2 || new Set(candleChunks).size !== candleChunks.length)
          throw new Error('Invalid chart chunk references');
        const sameChunks = early && listed!.length === candleChunks.length && listed!.every((hash, i) => hash === candleChunks[i]);
        const chunks = await Promise.all(sameChunks ? early : candleChunks.map(hash => object<Chunk>(release, hash, 'Chart')));
        if (chunks.some(chunk => chunk.symbol !== symbol || chunk.schemaVersion !== 1 || !Array.isArray(chunk.candles)))
          throw new Error('Chart chunk symbol/schema mismatch');
        const candles = chunks.flatMap(chunk => chunk.candles);
        if (candles.some((row, i) => !validDate(row.date) || row.date > release.sessionDate || (i > 0 && row.date <= candles[i - 1].date))
            || chart.historyStartDate !== (candles[0]?.date ?? null)) throw new Error('Chart chunk dates do not match release');
        return {...metadata, schemaVersion: 2, candles, asOfDate: release.sessionDate};
      }
      return {...chart, asOfDate: release.sessionDate};
    }
    if (!release.chartUrlTemplate) throw new Error('Chart release unavailable');
    const url = release.chartUrlTemplate.replace('{symbol}', encodeURIComponent(symbol));
    const chart = await cached(objectCache, url, () => getChartJson<ChartSnapshot>(url), 128);
    if (chart.symbol !== symbol || chart.asOfDate !== release.sessionDate) throw new Error('Chart session mismatch');
    return chart;
  }

  async getAnnouncementIndex(revision?: string): Promise<AnnouncementIndex> {
    const release = await releaseFor(revision);
    const catalog = await announcementReferences(release);
    const index = await object<AnnouncementIndex>(release, catalog.index);
    if (index.referenceSession !== release.sessionDate || index.publishedAt !== catalog.publishedAt) throw new Error('Announcement index mismatch');
    return index;
  }

  async getAnnouncementTopics(revision?: string): Promise<FilingTopic[]> {
    const release = await releaseFor(revision);
    const catalog = await announcementReferences(release);
    return (await object<{topics: FilingTopic[]}>(release, catalog.taxonomy)).topics;
  }

  async getAnnouncements(symbol: string, revision?: string): Promise<{records: Announcement[]; years: number[]; publishedAt: string}> {
    validSymbol(symbol);
    const release = await releaseFor(revision);
    const lookup = await filingLookup(release);
    if (lookup) {
      const entry = lookup.symbols[symbol];
      if (!entry) throw new Error('Announcement history unavailable for this symbol');
      const recent = await object<{symbol: string; records: Announcement[]}>(release, entry.recent);
      if (recent.symbol !== symbol) throw new Error('Announcement symbol mismatch');
      return {...recent, years: entry.years, publishedAt: lookup.publishedAt};
    }
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
    const entry = await companyAnnouncements(release, symbol);
    const pages = entry?.years[String(year)];
    if (!Number.isInteger(page) || page < 0 || !pages?.[page]) throw new Error('Announcement page unavailable');
    const result = await object<{symbol: string; records: Announcement[]}>(release, pages[pages.length - 1 - page].summary);
    if (result.symbol !== symbol) throw new Error('Announcement symbol mismatch');
    return {records: [...result.records].reverse(), pages: pages.length};
  }

  async getAnnouncementDetail(symbol: string, row: Announcement, revision?: string): Promise<Record<string, unknown>> {
    validSymbol(symbol);
    const release = await releaseFor(revision);
    const entry = await companyAnnouncements(release, symbol);
    const allowed = Object.values(entry?.years ?? {}).flat().some(page => page.details === row.detailPage);
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
    return {
      latestSessionDate: manifest.sessionDate,
      availableSessions: [{date:manifest.sessionDate, label:'Latest', isHistorical:false, revision:manifest.revision}],
      immutableRevision: manifest.revision,
      mainboardUniverseCount: manifest.totalStocks,
      catalogVersion: 'v4-snapshot',
    };
  }

  async getAvailableSessions(): Promise<Array<{ date: string; label: string; isHistorical: boolean; revision: string }>> {
    try {
      const resp = await fetch(dataUrl('/data/sessions.json'));
      if (resp.ok) {
        const data = await resp.json();
        if (Array.isArray(data.sessions) && data.sessions.length > 0) {
          return data.sessions;
        }
      }
    } catch {
      // Fallback to empty list
    }
    return [];
  }
}


export const realAdapter = new RealDataAdapter();
