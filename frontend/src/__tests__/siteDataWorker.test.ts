import {expect, it} from 'vitest';
import {pointerKey, serveSiteData, siteDataKey} from '../../../workers/screener-ai/siteData';

const revision = 'a'.repeat(64);
const origin = 'https://nexus-scanner.example.workers.dev';

interface Stored { body: string; contentType: string; contentEncoding?: string; etag?: string }

function bucket(objects: Record<string, Stored>) {
  const calls: string[] = [];
  const object = (key: string, withBody: boolean) => {
    const stored = objects[key];
    if (!stored) return null;
    const etag = stored.etag ?? `"${key.length}"`;
    return {
      httpEtag: etag,
      httpMetadata: {contentType: stored.contentType, contentEncoding: stored.contentEncoding},
      writeHttpMetadata(headers: Headers) {
        headers.set('Content-Type', stored.contentType);
        if (stored.contentEncoding) headers.set('Content-Encoding', stored.contentEncoding);
      },
      ...(withBody ? {body: new Response(stored.body).body!} : {}),
    };
  };
  return {
    calls,
    async get(key: string, options?: {onlyIf?: Headers}) {
      calls.push(`get ${key}`);
      const match = options?.onlyIf?.get('If-None-Match');
      return object(key, !(match && match === (objects[key]?.etag ?? `"${key.length}"`)));
    },
    async head(key: string) { calls.push(`head ${key}`); return object(key, false); },
  };
}

const fetchData = (data: ReturnType<typeof bucket>, path: string, init?: RequestInit) =>
  serveSiteData(new Request(origin + path, init), data);

it('maps /data paths onto the release layout Nexus Journal reads', () => {
  expect(siteDataKey('/data/current.json')).toEqual({key: 'site/data/current.json', immutable: false});
  expect(siteDataKey('/data/results/us_index.json')).toEqual({key: 'site/data/results/us_index.json', immutable: false});
  expect(siteDataKey('/data/company/current.json')).toEqual({key: 'site/data/company/current.json', immutable: false});
  expect(siteDataKey(`/data/revisions/${revision}/stocks.packed.json.gz`))
    .toEqual({key: `releases/${revision}/stocks.packed.json.gz`, immutable: true});
  expect(siteDataKey(`/data/revisions/${revision}/financial-history/M%26M.json.gz`))
    .toEqual({key: `releases/${revision}/financial-history/M&M.json.gz`, immutable: true});
  expect(siteDataKey(`/data/company/revisions/${revision}/overviews.json.gz`))
    .toEqual({key: `releases/company/${revision}/overviews.json.gz`, immutable: true});
});

it('publishes nothing outside the allowlist', () => {
  for (const path of [
    '/data/stocks.json', '/data/rotation/local.json', '/data/snapshots/2026-10-01.json.gz', '/data/objects/x.json.gz',
    '/data/revisions/abc/stocks.json', `/data/revisions/${revision}/a/b/c.json`, `/data/revisions/${revision}/../x.json`,
    `/data/revisions/${revision}/%2e%2e/current.json`, `/data/revisions/${revision}/charts.txt`,
    '/data/company/revisions/x/overviews.json.gz', '/data/%E0%A4%A', '/data/', '/datax/current.json',
  ]) expect(siteDataKey(path), path).toBeNull();
});

it('revalidates pointers and caches revision files as immutable', async () => {
  const data = bucket({
    'site/data/current.json': {body: '{"revision":"x"}', contentType: 'application/json'},
    [`releases/${revision}/stocks.json.gz`]: {body: 'gz', contentType: 'application/gzip'},
  });
  const pointer = await fetchData(data, '/data/current.json');
  expect(pointer.status).toBe(200);
  expect(await pointer.text()).toBe('{"revision":"x"}');
  expect(pointer.headers.get('Cache-Control')).toBe('no-cache');
  expect(pointer.headers.get('Content-Type')).toBe('application/json');
  expect(pointer.headers.get('Access-Control-Allow-Origin')).toBe('*');
  expect(pointer.headers.get('ETag')).toBeTruthy();
  const release = await fetchData(data, `/data/revisions/${revision}/stocks.json.gz`);
  expect(release.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
  expect(release.headers.get('Content-Encoding')).toBeNull();
  expect(data.calls).toEqual(['get site/data/current.json', `get releases/${revision}/stocks.json.gz`]);
});

it('keeps a stored Content-Encoding and the stored bytes', async () => {
  const data = bucket({'site/data/sessions.json': {body: 'gzipped', contentType: 'application/json', contentEncoding: 'gzip'}});
  const response = await fetchData(data, '/data/sessions.json');
  expect(response.headers.get('Content-Encoding')).toBe('gzip');
  expect(await response.text()).toBe('gzipped');
});

it('answers 404 for unknown and missing files, 304 for a matching ETag, and rejects writes', async () => {
  const data = bucket({'site/data/current.json': {body: '{}', contentType: 'application/json', etag: '"v1"'}});
  const unknown = await fetchData(data, '/data/stocks.json');
  expect(unknown.status).toBe(404);
  expect(data.calls).toEqual([]);
  expect((await fetchData(data, '/data/sessions.json')).status).toBe(404);
  const notModified = await fetchData(data, '/data/current.json', {headers: {'If-None-Match': '"v1"'}});
  expect(notModified.status).toBe(304);
  const head = await fetchData(data, '/data/current.json', {method: 'HEAD'});
  expect(head.status).toBe(200);
  expect(head.body).toBeNull();
  expect((await fetchData(data, '/data/current.json', {method: 'PUT', body: 'x'})).status).toBe(405);
});

it('keeps the AI filter catalogue next to the pointer it was built for', () => {
  expect(pointerKey('ai-filter-choices.json')).toBe(siteDataKey('/data/ai-filter-choices.json')?.key);
  expect(pointerKey('current.json')).toBe(siteDataKey('/data/current.json')?.key);
});
