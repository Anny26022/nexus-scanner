import { DataUnavailableError } from './dataErrors';
import type { SnapshotSource } from './snapshotEngine';

export interface Manifest {
  revision: string;
  sessionDate: string;
  datasetUrl: string;
  datasetGzipUrl?: string;
  datasetPackedGzipUrl?: string;
  themeClassificationUrl?: string;
  themeClassificationVersion?: string;
  iposUrl: string;
  totalStocks: number;
  schemaVersion: number;
  chartUrlTemplate?: string;
  chartRevision?: string;
  dataIndexUrl?: string;
  objectUrlTemplate?: string;
  thematicRrgUrl?: string;
  thematicRrgVersion?: string;
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
      || !validDate(manifest.sessionDate) || !validUrl(manifest.datasetUrl) || !validUrl(manifest.iposUrl)
      || !Number.isInteger(manifest.totalStocks) || manifest.totalStocks < 0
      || (manifest.chartRevision !== undefined && !/^[a-f0-9]{64}$/.test(manifest.chartRevision))
      || (manifest.schemaVersion === 6 && !manifest.chartUrlTemplate)
      || (manifest.schemaVersion === 7 && (!validUrl(manifest.dataIndexUrl) || !manifest.chartRevision
          || !validUrl(manifest.objectUrlTemplate) || manifest.objectUrlTemplate?.split('{hash}').length !== 2))
      || (manifest.chartUrlTemplate !== undefined && (!validUrl(manifest.chartUrlTemplate)
          || manifest.chartUrlTemplate.split('{symbol}').length !== 2))
      || (manifest.thematicRrgUrl !== undefined && (!validUrl(manifest.thematicRrgUrl)
          || !/^[a-f0-9]{64}$/.test(manifest.thematicRrgVersion ?? '')))) {
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

export function manifestSnapshotSource(manifest: Manifest, revision = manifest.revision, sessionDate?: string): SnapshotSource {
  if (!/^[a-f0-9]{64}$/.test(revision)) throw new Error('Invalid dataset revision');
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
  // Historical revisions keep their original URL; current releases advertise gzip.
  return {revision, url:revision === manifest.revision
    ? (typeof DecompressionStream !== 'undefined' ? manifest.datasetPackedGzipUrl ?? manifest.datasetGzipUrl : undefined) ?? manifest.datasetUrl
    : `/data/revisions/${revision}/stocks.json`,
  sessionDate:revision === manifest.revision ? manifest.sessionDate : undefined};
}

