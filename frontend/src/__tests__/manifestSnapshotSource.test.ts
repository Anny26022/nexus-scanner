import { expect, it } from 'vitest';
import { manifestSnapshotSource, type Manifest } from '../api/manifest';

const revision = 'a'.repeat(64);
const historicalRevision = 'b'.repeat(64);
const manifest: Manifest = {revision, schemaVersion:4, sessionDate:'2026-10-19',
  datasetUrl:'/data/revisions/current/stocks.json', iposUrl:'/data/ipos.json', totalStocks:1};

it.each([undefined, 'https://cdn.example.com/objects/{hash}.json.gz'])(
  'uses immutable historical keys with a legacy fallback (template %s)', objectUrlTemplate => {
    const base = objectUrlTemplate ? 'https://cdn.example.com' : '/data';
    expect(manifestSnapshotSource({...manifest, objectUrlTemplate}, historicalRevision, '2026-10-09')).toEqual({
      revision:historicalRevision, sessionDate:'2026-10-09',
      url:`${base}/snapshots/2026-10-09/${historicalRevision}.json.gz`,
      fallbackUrl:`${base}/snapshots/2026-10-09.json.gz?v=${historicalRevision.slice(0,16)}`,
    });
  });

it('keeps current releases and revision lookups on their advertised URLs', () => {
  expect(manifestSnapshotSource(manifest)).toEqual({revision, url:manifest.datasetUrl, sessionDate:manifest.sessionDate});
  expect(manifestSnapshotSource(manifest, historicalRevision)).toEqual({revision:historicalRevision,
    url:`/data/revisions/${historicalRevision}/stocks.json`, sessionDate:undefined});
});
