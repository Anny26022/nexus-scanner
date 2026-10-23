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

test('answers repeat GETs from the edge cache without reading R2', async () => {
  const store = new Map();
  globalThis.caches = { default: {
    async match(request) { return store.get(request.url)?.clone(); },
    async put(request, response) { store.set(request.url, response); },
  } };
  const pending = [];
  const ctx = { waitUntil(promise) { pending.push(promise); } };
  try {
    const before = calls.length;
    const first = await worker.fetch(new Request('https://data.example.com/objects/cached.json.gz'), env, ctx);
    assert.equal(await first.text(), 'published bytes');
    await Promise.all(pending);
    const second = await worker.fetch(new Request('https://data.example.com/objects/cached.json.gz'), env, ctx);
    assert.equal(await second.text(), 'published bytes');
    assert.equal(calls.length, before + 1); // only the first read reached R2
  } finally {
    delete globalThis.caches;
  }
});
