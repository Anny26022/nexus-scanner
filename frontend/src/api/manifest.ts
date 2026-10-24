import { DataUnavailableError } from './dataErrors';
import type { SnapshotSource } from './snapshotEngine';

export interface Manifest {
  revision: string;
  sessionDate: string;
  datasetUrl: string;
  etfDatasetUrl?: string;
  datasetGzipUrl?: string;
  datasetPackedGzipUrl?: string;
  themeClassificationUrl?: string;
  themeClassificationVersion?: string;
  marketOverviewUrl?: string;
  benchmarkUrl?: string;
  chartDirectoryUrl?: string;
  financialHistoryUrl?: string;
  financialHistoryUrlTemplate?: string;
  earningsCalendarUrl?: string;
  /** Dated price-band changes per symbol since the first archived session. */
  priceBandHistoryUrl?: string;
  iposUrl: string;
  totalStocks: number;
  schemaVersion: number;
  chartUrlTemplate?: string;
  chartRevision?: string;
  dataIndexUrl?: string;
  objectUrlTemplate?: string;
  /** Rotation page price history: its index hash and where its files live; or (local development) a direct URL. */
  rotationHistoryObject?: string;
  rotationUrlTemplate?: string;
  rotationHistoryUrl?: string;
}
let current: Manifest | undefined;
let pending: Promise<Manifest> | undefined;
let initial: Promise<Manifest> | undefined;

export const validDate = (date: unknown) => typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)
  && !Number.isNaN(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date;

export function validateManifest(value: unknown): Manifest {
  const manifest = value as Manifest | null;
  const validUrl = (url: unknown) => typeof url === 'string' && !/\s/.test(url)
    && (/^\/(?!\/).+/.test(url) || /^https:\/\/[^/]+\/.+/.test(url));
  if (!manifest || !/^[a-f0-9]{64}$/.test(manifest.revision) || ![4, 5, 6, 7].includes(manifest.schemaVersion)
      || (manifest.datasetGzipUrl !== undefined && (!validUrl(manifest.datasetGzipUrl) || !manifest.datasetGzipUrl.endsWith('.json.gz')))
      || (manifest.datasetPackedGzipUrl !== undefined && (!validUrl(manifest.datasetPackedGzipUrl) || !manifest.datasetPackedGzipUrl.endsWith('.json.gz')))
      || (manifest.themeClassificationUrl !== undefined && (!validUrl(manifest.themeClassificationUrl) || !manifest.themeClassificationUrl.endsWith('.json.gz')
          || !/^[a-f0-9]{64}$/.test(manifest.themeClassificationVersion ?? '')))
      || (manifest.financialHistoryUrlTemplate !== undefined && (!validUrl(manifest.financialHistoryUrlTemplate) || !manifest.financialHistoryUrlTemplate.endsWith('.json.gz') || manifest.financialHistoryUrlTemplate.split('{symbol}').length !== 2))
      || [manifest.etfDatasetUrl, manifest.financialHistoryUrl, manifest.earningsCalendarUrl, manifest.priceBandHistoryUrl].some(url => url !== undefined && (!validUrl(url) || !url.endsWith('.json.gz')))
      || (manifest.chartDirectoryUrl !== undefined && (!validUrl(manifest.chartDirectoryUrl) || !manifest.chartDirectoryUrl.endsWith('.json.gz')))
      || (manifest.benchmarkUrl !== undefined && (!validUrl(manifest.benchmarkUrl) || !manifest.benchmarkUrl.endsWith('.json.gz')))
      || (manifest.marketOverviewUrl !== undefined && (!validUrl(manifest.marketOverviewUrl) || !manifest.marketOverviewUrl.endsWith('.json.gz')))
      || !validDate(manifest.sessionDate) || !validUrl(manifest.datasetUrl) || !validUrl(manifest.iposUrl)
      || !Number.isInteger(manifest.totalStocks) || manifest.totalStocks < 0
      || (manifest.chartRevision !== undefined && !/^[a-f0-9]{64}$/.test(manifest.chartRevision))
      || (manifest.rotationHistoryObject !== undefined && !/^[a-f0-9]{64}$/.test(manifest.rotationHistoryObject))
      || (manifest.rotationUrlTemplate !== undefined && (!validUrl(manifest.rotationUrlTemplate) || manifest.rotationUrlTemplate.split('{hash}').length !== 2))
      || (manifest.rotationHistoryUrl !== undefined && (!validUrl(manifest.rotationHistoryUrl) || !/[a-f0-9]{64}\.json\.gz$/.test(manifest.rotationHistoryUrl)))
      || (manifest.schemaVersion === 6 && !manifest.chartUrlTemplate)
      || (manifest.schemaVersion === 7 && (!validUrl(manifest.dataIndexUrl) || !manifest.chartRevision
          || !validUrl(manifest.objectUrlTemplate) || manifest.objectUrlTemplate?.split('{hash}').length !== 2))
      || (manifest.chartUrlTemplate !== undefined && (!validUrl(manifest.chartUrlTemplate)
          || manifest.chartUrlTemplate.split('{symbol}').length !== 2))) {
    throw new Error('Invalid scanner dataset manifest');
  }
  return manifest;
}

async function readManifest(): Promise<Manifest> {
  const response = await fetch('/data/current.json', {cache:'no-store'});
  if (!response.ok) throw new DataUnavailableError(`Dataset request failed (HTTP ${response.status})`, response.status === 404 ? 'not_found' : 'download_failed');
  let value: unknown;
  try { value = await response.json(); }
  catch (error) {
    if (error instanceof SyntaxError) throw new DataUnavailableError('Dataset file is missing or invalid. The host may be returning a page instead of data.', 'not_found');
    throw new DataUnavailableError('Dataset download failed. Please retry.', 'download_failed');
  }
  return current = validateManifest(value);
}

export function refreshManifest(): Promise<Manifest> {
  // Consume the startup read once, even if it finished before React mounted.
  const request = initial ?? (pending ??= readManifest().finally(() => { pending = undefined; }));
  initial = undefined;
  return request;
}

export function preloadManifest(): Promise<Manifest> {
  return initial ??= refreshManifest();
}

export const getManifest = () => current ? Promise.resolve(current) : refreshManifest();

export function manifestSnapshotSource(manifest: Manifest, revision = manifest.revision, sessionDate?: string, etf = false): SnapshotSource {
  if (!/^[a-f0-9]{64}$/.test(revision)) throw new Error('Invalid dataset revision');
  if (etf) {
    if (!manifest.etfDatasetUrl) throw new Error('ETF snapshots will be available after the next daily refresh.');
    if (revision !== manifest.revision || sessionDate && sessionDate !== manifest.sessionDate) {
      throw new Error('ETF screens support only the latest snapshot.');
    }
    return {revision, sessionDate:manifest.sessionDate, url:manifest.etfDatasetUrl};
  }
  if (sessionDate && sessionDate !== manifest.sessionDate) {
    const baseUrl = manifest.objectUrlTemplate
      ? manifest.objectUrlTemplate.replace(/\/objects\/\{hash\}\.json\.gz$/, '')
      : '';
    const url = baseUrl ? `${baseUrl}/snapshots/${sessionDate}.json.gz?v=${revision.slice(0, 16)}` : `/data/snapshots/${sessionDate}.json.gz?v=${revision.slice(0, 16)}`;
    return {
      revision,
      sessionDate,
      url,
    };
  }
  // A tab still on the previous release reads its gzip copy. Plain JSON, only for browsers that cannot
  // decompress, is served from R2 (at ~25 MiB it is too large for static assets).
  const gzip = typeof DecompressionStream !== 'undefined';
  const plain = manifest.objectUrlTemplate
    ? `${manifest.objectUrlTemplate.replace(/\/objects\/\{hash\}\.json\.gz$/, '')}/releases/${revision}/stocks.json`
    : `/data/revisions/${revision}/stocks.json`;
  return {revision, url:revision === manifest.revision
    ? (gzip ? manifest.datasetPackedGzipUrl ?? manifest.datasetGzipUrl : undefined) ?? manifest.datasetUrl
    : gzip ? `/data/revisions/${revision}/stocks.json.gz` : plain,
  sessionDate:revision === manifest.revision ? manifest.sessionDate : undefined};
}

