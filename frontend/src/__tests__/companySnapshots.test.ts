import { gzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { getCompanySnapshots } from '../api/companySnapshots';

afterEach(() => vi.unstubAllGlobals());
const revision = 'a'.repeat(64);
const manifest = {schemaVersion: 1, revision, datasetUrl: `/data/company/revisions/${revision}/overviews.json.gz`};
const reports = {TEST: {name: 'Test', as_of: '2026-10-01', the_read: ['Company overview'], what_to_watch: [], key_events: []}};

it.each(['raw gzip', 'browser-decoded gzip'])('loads %s publication bytes', async encoding => {
  const bytes = encoding === 'raw gzip' ? gzipSync(JSON.stringify(reports)) : JSON.stringify(reports);
  const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(manifest)))
    .mockResolvedValueOnce(new Response(bytes));
  vi.stubGlobal('fetch', fetch);
  expect(await getCompanySnapshots()).toEqual(reports);
  expect(fetch).toHaveBeenNthCalledWith(2, manifest.datasetUrl);
});

it('rejects mismatched revision URLs before downloading an object', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({...manifest, datasetUrl: '/other.json.gz'})));
  vi.stubGlobal('fetch', fetch);
  await expect(getCompanySnapshots()).rejects.toThrow('reference is invalid');
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('reports publication download failures', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(manifest)))
    .mockResolvedValueOnce(new Response('', {status: 404}));
  vi.stubGlobal('fetch', fetch);
  await expect(getCompanySnapshots()).rejects.toThrow('could not be loaded');
  expect(fetch).toHaveBeenCalledTimes(2);
});

it.each([
  {the_read:'not an array'}, {the_read:[{}]},
  {what_to_watch:'not an array'}, {what_to_watch:[{title:7, window:'', body:''}]},
  {key_events:'not an array'},
])('rejects malformed report sections: %j', invalid => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(manifest)))
    .mockResolvedValueOnce(new Response(JSON.stringify({TEST:{...reports.TEST, ...invalid}}))));
  return expect(getCompanySnapshots()).rejects.toThrow('snapshots are invalid');
});

it('accepts an exported report without a parseable as-of date', async () => {
  const nullable = {TEST:{...reports.TEST, as_of:null}};
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(manifest)))
    .mockResolvedValueOnce(new Response(JSON.stringify(nullable))));
  expect(await getCompanySnapshots()).toEqual(nullable);
});

it('drops malformed events without rejecting valid company reports', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(manifest)))
    .mockResolvedValueOnce(new Response(JSON.stringify({TEST:{...reports.TEST,
      key_events:[null, {label:7}, {label:'Valid undated event'}, {label:'Dated event',chart_date:'2026-10-01'}]}}))));
  expect((await getCompanySnapshots()).TEST.key_events).toEqual([
    {label:'Valid undated event',chart_date:''}, {label:'Dated event',chart_date:'2026-10-01'},
  ]);
});

it('accepts the real published catalogue, including partial source events', async () => {
  const current = JSON.parse(readFileSync('public/data/company/current.json', 'utf8'));
  const publication = readFileSync(`public${current.datasetUrl}`);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(current)))
    .mockResolvedValueOnce(new Response(publication)));
  const loaded = await getCompanySnapshots();
  expect(Object.keys(loaded).length).toBeGreaterThan(2000);
  for (const report of Object.values(loaded)) {
    expect(report.key_events.every(event => typeof event.label === 'string' && typeof event.chart_date === 'string')).toBe(true);
  }
});
