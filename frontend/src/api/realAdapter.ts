import type { ScreenerRunRequest, ScreenerRunResponse, IPORow, ExplainRequest, ExplainResponse,
  SymbolComparisonRequest, SymbolComparisonResponse, RevisionCurrentResponse } from '../types/screener';
import { NEXUS_CONDITION_CATALOG } from '../data/conditionCatalog';
import type { IpoCatalogue } from '../types/screener';
import { runSnapshotTask } from './snapshotClient';
import type { SnapshotSource } from './snapshotEngine';
import { filterAnnouncements, type Announcement, type AnnouncementCatalog, type AnnouncementIndex, type FilingTopic } from './announcements';
import { DataUnavailableError } from './dataErrors';
import { getManifest, refreshManifest, validateManifest, validDate, manifestSnapshotSource, type Manifest } from './manifest';
export { refreshManifest } from './manifest';
const ipoSnapshots = new Map<string, Promise<IpoCatalogue>>();
const finiteAmount = (value: unknown): number | null => {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

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
interface DataIndex { revision: string; asOfDate: string; chartObjects: Record<string, string>; announcements: string; filingLookup?: FilingLookup }
async function releaseFor(revision?: string): Promise<Manifest> {
  const latest = await getManifest();
  const selected = revision ?? latest.revision;
  if (!/^[a-f0-9]{64}$/.test(selected)) throw new Error('Invalid dataset revision');
  if (selected === latest.revision) return latest;
  try {
    const release = validateManifest(await cached(
      releaseCache, selected, () => getJson<unknown>(`/data/revisions/${selected}/release.json`), 3));
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
function validSymbol(symbol: string) {
  if (!/^[A-Z0-9&_-]+$/.test(symbol)) throw new Error('Invalid symbol');
}
async function announcementCatalog(release: Manifest): Promise<AnnouncementCatalog> {
  const index = await dataIndex(release);
  const catalog = await object<AnnouncementCatalog>(release, index.announcements);
  if (catalog.referenceSession !== release.sessionDate) throw new Error('Announcement release mismatch');
  return catalog;
}

async function announcementReferences(release: Manifest) {
  return (await dataIndex(release)).filingLookup ?? announcementCatalog(release);
}

async function companyAnnouncements(release: Manifest, symbol: string) {
  const lookup = (await dataIndex(release)).filingLookup;
  if (!lookup) return (await announcementCatalog(release)).symbols[symbol];
  const entry = lookup.symbols[symbol];
  if (!entry) throw new Error('Announcement history unavailable for this symbol');
  const history = await object<AnnouncementCatalog['symbols'][string] & {symbol: string}>(release, entry.history);
  if (history.symbol !== symbol || history.recent !== entry.recent) throw new Error('Announcement history mismatch');
  return history;
}

async function getIpoJson<T>(url: string, resource = 'IPO catalogue'): Promise<T> {
  if (!url.endsWith('.gz')) return getJson<T>(url);
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!bytes.length) throw new Error('Empty IPO catalogue');
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
      if (typeof DecompressionStream === 'undefined') throw new Error('Gzip unsupported');
      const stream = new Response(bytes).body!.pipeThrough(new DecompressionStream('gzip'));
      return JSON.parse(await new Response(stream).text()) as T;
    }
    // Fetch decodes Content-Encoding before returning bytes (including Vite 8).
    if (response.headers.get('Content-Encoding')?.toLowerCase() === 'gzip') {
      return JSON.parse(new TextDecoder().decode(bytes)) as T;
    }
    throw new Error('Expected gzip');
  } catch {
    throw new Error(`${resource} unavailable`);
  }
}

async function snapshotSource(revision?: string, sessionDate?: string): Promise<SnapshotSource> {
  return manifestSnapshotSource(await getManifest(), revision, sessionDate);
}

class RealDataAdapter {
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
  async getFilterChoices(revision?: string, sessionDate?: string) {
    const response = await runSnapshotTask({type:'filterChoices',source:await snapshotSource(revision, sessionDate)});
    if (response.type !== 'filterChoices') throw new Error('Unexpected filter choices response');
    return response.result;
  }
  async getCatalog() { return NEXUS_CONDITION_CATALOG; }

  async explainScreen(_req: ExplainRequest): Promise<ExplainResponse> {
    return { isValid:true, errors:[], compiledExplanations:[], warnings:[] };
  }

  async runScreen(req: ScreenerRunRequest, allRows = false): Promise<ScreenerRunResponse> {
    const announcementFilter = req.announcementFilter;
    if (announcementFilter) {
      const release = await releaseFor(req.datasetRevision);
      req = {...req, datasetRevision: release.revision};
      const index = await this.getAnnouncementIndex(req.datasetRevision);
      const matches = filterAnnouncements(index, announcementFilter);
      req = {...req, announcementSymbols: [...new Set(matches.map(row => row.symbol!))]};
    }
    const source = await snapshotSource(req.datasetRevision, req.asOfDate);

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
              ipoDecode: r.provider?.id ? {
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
              scanx: r.scanx ? {
                offer: r.scanx.listed ? {
                  floorPrice: r.scanx.details?.floor_price ?? null,
                  ceilingPrice: r.scanx.details?.ceiling_price ?? null,
                  lotSize: r.scanx.details?.trading_lot ?? null,
                  startDate: r.scanx.listed.ipo_start_date ?? null,
                  endDate: r.scanx.listed.ipo_end_date ?? null,
                } : undefined,
                issueSize: r.scanx.details?.issue_size ?? null,
                allotmentDate: r.scanx.details?.allotment_date ?? null,
                companyDetail: r.scanx.details?.company_detail ?? null,
                financials: Array.isArray(r.scanx.details?.financials) ? r.scanx.details.financials.map((item: any) => ({
                  date: item.date, unit: item.unit,
                  revenue: finiteAmount(item.pl?.revenue_from_operations ?? item.pl?.total_revenue),
                  profit: finiteAmount(item.pl?.total_profit),
                })) : [],
                purpose: Array.isArray(r.scanx.details?.ipoPurpose) ? r.scanx.details.ipoPurpose.map((item: any) => ({
                  title: item.title, description: item.description, amount: item.total_amount, unit: item.unit,
                })) : [],
                strengths: Array.isArray(r.scanx.details?.strengths) ? r.scanx.details.strengths.map((item: any) => ({title: item.title, description: item.description})) : [],
                risks: Array.isArray(r.scanx.details?.riskFactors) ? r.scanx.details.riskFactors.map((item: any) => ({title: item.title, description: item.description})) : [],
                management: Array.isArray(r.scanx.details?.managementTeam) ? r.scanx.details.managementTeam.map((item: any) => ({name: item.name, designation: item.designation})) : [],
                drhpUrl: r.scanx.details?.drhp_doc ?? r.scanx.details?.sym_doc_url ?? null,
              } : undefined,
              conflicts: Array.isArray(r.enrichment_conflicts) ? r.enrichment_conflicts
                .filter((item: any) => typeof item?.field === 'string')
                .map((item: any) => ({field: item.field, provider: item.provider ?? null, scanx: item.scanx ?? null})) : [],
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

  async getChart(symbol: string, revision?: string): Promise<ChartSnapshot> {
    validSymbol(symbol);
    const release = await releaseFor(revision);
    if (release.schemaVersion === 7) {
      const index = await dataIndex(release);
      const chart = await object<ChartSnapshot & {candleChunks?: string[]}>(release, index.chartObjects[symbol], 'Chart');
      if (chart.symbol !== symbol || ![2, 3].includes(chart.schemaVersion)) throw new Error('Chart symbol/schema mismatch');
      if (chart.schemaVersion === 3) {
        const {candleChunks, ...metadata} = chart;
        if (!Array.isArray(candleChunks) || candleChunks.length > 2 || new Set(candleChunks).size !== candleChunks.length)
          throw new Error('Invalid chart chunk references');
        const chunks = await Promise.all(candleChunks.map(hash => object<{schemaVersion:number;symbol:string;candles:ChartSnapshot['candles']}>(release, hash, 'Chart')));
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
    const lookup = (await dataIndex(release)).filingLookup;
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
      const resp = await fetch('/data/sessions.json');
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
