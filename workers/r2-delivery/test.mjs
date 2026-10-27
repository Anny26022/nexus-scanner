import assert from 'node:assert/strict';
import { test } from 'node:test';
import worker from './src/index.mjs';

const calls = [];
const object = {
  body: 'published bytes',
  httpEtag: '"abc"',
  writeHttpMetadata(headers) { headers.set('Content-Type', 'application/gzip'); },
};
const env = { DATA: {
  async get(key) { calls.push(['get', key]); return object; },
  async head(key) { calls.push(['head', key]); return object; },
} };

test('serves published objects with browser-readable metadata', async () => {
  const response = await worker.fetch(new Request('https://data.example.com/objects/abc.json.gz'), env);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'published bytes');
  assert.equal(response.headers.get('Content-Type'), 'application/gzip');
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*');
  assert.deepEqual(calls.pop(), ['get', 'objects/abc.json.gz']);
});

test('serves published historical snapshots', async () => {
  const response = await worker.fetch(new Request('https://data.example.com/snapshots/2021-10-14.json.gz'), env);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'published bytes');
  assert.deepEqual(calls.pop(), ['get', 'snapshots/2021-10-14.json.gz']);
});

test('caches content-addressed rotation history as immutable, other daily files not', async () => {
  const rotation = await worker.fetch(new Request(`https://data.example.com/daily/rotation/${'a'.repeat(64)}.json.gz`), env);
  assert.equal(rotation.headers.get('Cache-Control'), 'public, max-age=31536000, immutable');
  const chart = await worker.fetch(new Request('https://data.example.com/daily/2026-10-23/abc/charts/TEST.json.gz'), env);
  assert.equal(chart.headers.get('Cache-Control'), 'no-cache');
});

test('HEAD returns metadata without a body', async () => {
  const response = await worker.fetch(new Request('https://data.example.com/releases/abc/index.json', { method: 'HEAD' }), env);
  assert.equal(response.status, 200);
  assert.equal(response.body, null);
  assert.deepEqual(calls.pop(), ['head', 'releases/abc/index.json']);
});

test('does not expose other bucket prefixes or write methods', async () => {
  const missing = await worker.fetch(new Request('https://data.example.com/private/file'), env);
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get('Access-Control-Allow-Origin'), '*');
  assert.equal((await worker.fetch(new Request('https://data.example.com/objects/file', { method: 'PUT' }), env)).status, 405);
});

test('only immutable paths receive a long cache lifetime', async () => {
  for (const path of ['objects/abc.json.gz', 'releases/abc/index.json']) {
    const response = await worker.fetch(new Request(`https://data.example.com/${path}`), env);
    assert.equal(response.headers.get('Cache-Control'), 'public, max-age=31536000, immutable');
  }
  for (const path of ['snapshots/2026-10-23.json.gz', 'daily/abc.json.gz', 'monthly/abc.json.gz']) {
    const response = await worker.fetch(new Request(`https://data.example.com/${path}`), env);
    assert.equal(response.headers.get('Cache-Control'), 'no-cache');
  }
  const response = await worker.fetch(new Request('https://data.example.com/private/file'), env);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
});

test('snapshots that name their revision are immutable; unversioned or malformed ones revalidate', async () => {
  const versioned = await worker.fetch(new Request('https://data.example.com/snapshots/2026-10-23.json.gz?v=0123456789abcdef'), env);
  assert.equal(versioned.headers.get('Cache-Control'), 'public, max-age=31536000, immutable');
  for (const query of ['', '?v=', '?v=0123456789ABCDEF', '?v=0123456789abcde', '?v=0123456789abcdef0', '?w=0123456789abcdef']) {
    const response = await worker.fetch(new Request(`https://data.example.com/snapshots/2026-10-23.json.gz${query}`), env);
    assert.equal(response.headers.get('Cache-Control'), 'no-cache', query);
  }
  const daily = await worker.fetch(new Request('https://data.example.com/daily/abc.json.gz?v=0123456789abcdef'), env);
  assert.equal(daily.headers.get('Cache-Control'), 'no-cache');
});

test('objects stored with gzip Content-Encoding are served as the gzip file they are', async () => {
  const legacy = { ...object, httpMetadata: { contentType: 'application/json', contentEncoding: 'gzip' },
    writeHttpMetadata(headers) { headers.set('Content-Type', 'application/json'); headers.set('Content-Encoding', 'gzip'); } };
  const store = { DATA: { async get() { return legacy; }, async head() { return legacy; } } };
  const response = await worker.fetch(new Request('https://data.example.com/snapshots/2025-08-07.json.gz?v=2cd4e13d58e3477d'), store);
  assert.equal(response.headers.get('Content-Encoding'), null);
  assert.equal(response.headers.get('Content-Type'), 'application/gzip');
  assert.equal(await response.text(), 'published bytes');
});
