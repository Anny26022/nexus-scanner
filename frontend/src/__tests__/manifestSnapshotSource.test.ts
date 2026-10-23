import { afterEach, expect, it, vi } from 'vitest';
import { manifestSnapshotSource, type Manifest } from '../api/manifest';

const current = 'a'.repeat(64), previous = 'b'.repeat(64);
const manifest = {revision: current, sessionDate: '2026-10-23', schemaVersion: 7, totalStocks: 1,
  datasetUrl: `/data/revisions/${current}/stocks.json`, datasetPackedGzipUrl: `/data/revisions/${current}/stocks.packed.json.gz`,
  iposUrl: `/data/revisions/${current}/ipos.json.gz`} as Manifest;
afterEach(() => vi.unstubAllGlobals());

it('reads a superseded revision from its gzip copy, which is all it keeps', () => {
  vi.stubGlobal('DecompressionStream', class {});
  expect(manifestSnapshotSource(manifest, previous).url).toBe(`/data/revisions/${previous}/stocks.json.gz`);
  expect(manifestSnapshotSource(manifest).url).toBe(manifest.datasetPackedGzipUrl);
});

it('falls back to plain JSON only where the browser cannot decompress, from R2 once releases use it', () => {
  vi.stubGlobal('DecompressionStream', undefined);
  expect(manifestSnapshotSource(manifest, previous).url).toBe(`/data/revisions/${previous}/stocks.json`);
  expect(manifestSnapshotSource(manifest).url).toBe(manifest.datasetUrl);
  const r2 = {...manifest, datasetUrl: `https://data.example.com/releases/${current}/stocks.json`, objectUrlTemplate: 'https://data.example.com/objects/{hash}.json.gz'};
  expect(manifestSnapshotSource(r2, previous).url).toBe(`https://data.example.com/releases/${previous}/stocks.json`);
  expect(manifestSnapshotSource(r2).url).toBe(r2.datasetUrl);
});
