import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gateway, serveObject } from './src/delivery.mjs';

const worker = { fetch: serveObject };

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

// Scanner token gate. Test-only key and tokens shared with nexus-journal-api's signer; never deploy this key.
const SECRET = 'test-gateway-secret';
const USER = 'c0ffee00c0ffee00c0ffee00c0ffee00';
// The headers nexus-journal-api forwards with (workers/auth/scannerGateway.mjs).
const fromJournal = (secret = SECRET, user = USER) => ({ 'X-Nexus-Gateway': secret, 'X-Nexus-User': user });

function gate(path, { mode, headers = {}, method = 'GET', limits = {}, secrets = SECRET } = {}) {
  const forwarded = [];
  const limiterCalls = [];
  const limiter = (name) => ({ async limit({ key }) { limiterCalls.push([name, key]); return { success: limits[name] !== false }; } });
  const gateEnv = { ...env, AUTH_MODE: mode, SCANNER_GATEWAY_SECRET: secrets,
    DELIVERY_RATE_LIMITER: limiter('delivery'), SNAPSHOT_RATE_LIMITER: limiter('snapshot') };
  const result = gateway(new Request(`https://data.example.com/${path}`, { method, headers }), gateEnv, async (request) => {
    forwarded.push(request);
    return new Response('cached bytes', { headers: { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=31536000, immutable' } });
  });
  return { result, forwarded, limiterCalls };
}

test('off and report modes serve everyone, report checks the gateway', async () => {
  for (const mode of ['off', 'report', undefined]) {
    for (const headers of [{}, fromJournal('wrong')]) {
      const { result, forwarded } = gate('releases/abc/index.json', { mode, headers });
      assert.equal((await result).status, 200, `${mode}`);
      assert.equal(forwarded.length, 1);
    }
  }
});

test('enforce refuses a request that did not come through the Journal, with a readable 401', async () => {
  for (const [headers, reason] of [[{}, 'missing'], [fromJournal('wrong'), 'secret'], [{ Authorization: 'Bearer x' }, 'missing']]) {
    const { result, forwarded } = gate('objects/abc.json.gz', { mode: 'enforce', headers });
    const response = await result;
    assert.equal(response.status, 401, reason);
    assert.equal((await response.json()).reason, reason);
    assert.equal(forwarded.length, 0);
  }
});

test('enforce serves a request the Journal forwarded, without its headers or any credentials', async () => {
  const { result, forwarded } = gate('objects/abc.json.gz', { mode: 'enforce', headers: { ...fromJournal(), Cookie: 'nexus_gsession=x' } });
  assert.equal(await (await result).text(), 'cached bytes');
  for (const name of ['X-Nexus-Gateway', 'X-Nexus-User', 'Cookie', 'Authorization']) assert.equal(forwarded[0].headers.get(name), null, name);
  assert.equal(forwarded[0].url, 'https://data.example.com/objects/abc.json.gz');
});

test('accepts any of several secrets, so the secret can be changed without downtime', async () => {
  const { result } = gate('objects/abc.json.gz', { mode: 'enforce', headers: fromJournal('next-secret'), secrets: `${SECRET}, next-secret` });
  assert.equal((await result).status, 200);
});

test('limits each account, with a separate limit for session history', async () => {
  const objects = gate('objects/abc.json.gz', { mode: 'enforce', headers: fromJournal() });
  await objects.result;
  const snapshots = gate('snapshots/2026-10-23.json.gz', { mode: 'enforce', headers: fromJournal(), limits: { snapshot: false } });
  const response = await snapshots.result;
  assert.deepEqual(objects.limiterCalls, [['delivery', USER]]);
  assert.deepEqual(snapshots.limiterCalls, [['snapshot', USER]]);
  assert.equal(response.status, 429);
  assert.equal(snapshots.forwarded.length, 0);
});

test('an unconfigured secret fails closed in enforce mode', async () => {
  const response = await gate('objects/abc.json.gz', { mode: 'enforce', headers: fromJournal(), secrets: '' }).result;
  assert.equal(response.status, 401);
  assert.equal((await response.json()).reason, 'not_configured');
});

test('gated responses are private to shared caches, unchanged while off', async () => {
  for (const mode of ['report', 'enforce']) {
    const { result } = gate('objects/abc.json.gz', { mode, headers: fromJournal() });
    assert.equal((await result).headers.get('Cache-Control'), 'private, max-age=31536000, immutable', mode);
  }
  const { result } = gate('objects/abc.json.gz', { mode: 'off' });
  assert.equal((await result).headers.get('Cache-Control'), 'public, max-age=31536000, immutable');
});
