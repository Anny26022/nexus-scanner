import { gzipSync } from 'node:zlib';
import { afterEach, expect, it, vi } from 'vitest';
import { getTijoriOverviews } from '../api/tijori';

afterEach(() => vi.unstubAllGlobals());
const revision = 'a'.repeat(64);
const manifest = {schemaVersion: 1, revision, datasetUrl: `/data/tijori/revisions/${revision}/overviews.json.gz`};
const reports = {TEST: {name: 'Test', as_of: '2026-10-01', the_read: ['Company overview'], what_to_watch: [], key_events: []}};

it.each(['raw gzip', 'browser-decoded gzip'])('loads %s publication bytes', async encoding => {
  const bytes = encoding === 'raw gzip' ? gzipSync(JSON.stringify(reports)) : JSON.stringify(reports);
  const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(manifest)))
    .mockResolvedValueOnce(new Response(bytes));
  vi.stubGlobal('fetch', fetch);
  expect(await getTijoriOverviews()).toEqual(reports);
  expect(fetch).toHaveBeenNthCalledWith(2, manifest.datasetUrl);
});

it('rejects mismatched revision URLs before downloading an object', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({...manifest, datasetUrl: '/other.json.gz'})));
  vi.stubGlobal('fetch', fetch);
  await expect(getTijoriOverviews()).rejects.toThrow('reference is invalid');
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('reports publication download failures', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', {status: 404})));
  await expect(getTijoriOverviews()).rejects.toThrow('could not be loaded');
});
