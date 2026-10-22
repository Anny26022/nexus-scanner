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
  for (const key of ['snapshots/2021-10-14.json.gz', `snapshots/2021-10-14/${'a'.repeat(64)}.json.gz`]) {
    const response = await worker.fetch(new Request(`https://data.example.com/${key}`), env);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'published bytes');
    assert.deepEqual(calls.pop(), ['get', key]);
  }
});

test('exposes gzip encoding so cross-origin clients recognize browser-decoded snapshots', async () => {
  const gzipObject = {...object, writeHttpMetadata(headers) {
    headers.set('Content-Type', 'application/json');
    headers.set('Content-Encoding', 'gzip');
  }};
  const response = await worker.fetch(new Request(`https://data.example.com/snapshots/2026-10-01/${'a'.repeat(64)}.json.gz`,
    {headers:{Origin:'https://scanner.example.com'}}), {DATA:{async get() {return gzipObject;}}});
  assert.equal(response.headers.get('Content-Encoding'), 'gzip');
  assert.ok(response.headers.get('Access-Control-Expose-Headers').split(/,\s*/).includes('Content-Encoding'));
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
