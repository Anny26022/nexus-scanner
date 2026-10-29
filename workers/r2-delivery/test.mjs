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
const PUBLIC_KEYS = JSON.stringify({ 'test-1': '6kpsY-KcUgq-9VB7Ey7F-ZVHdq6-vnuSQh7qaRRG0iw' });
const TOKENS = {
  valid: 'eyJ2IjoxLCJraWQiOiJ0ZXN0LTEiLCJzdWIiOiJjMGZmZWUwMGMwZmZlZTAwYzBmZmVlMDBjMGZmZWUwMCIsImF1ZCI6Im5leHVzLXNjYW5uZXIiLCJzY29wZSI6WyJkYXRhIiwiYWkiXSwic3JjIjoibGF1bmNoIiwiaWF0IjoxNzY3MjI1NjAwLCJleHAiOjQxMDI0NDQ4MDB9.D0lyBf0BvLu2H5eYKLEK8VR6s5Gcq3OqIc4oKrqxmghGyIijh8p_Dmo05Dm3V9Dy4JxjzKT2PSrh1gbkBlriAw',
  expired: 'eyJ2IjoxLCJraWQiOiJ0ZXN0LTEiLCJzdWIiOiJjMGZmZWUwMGMwZmZlZTAwYzBmZmVlMDBjMGZmZWUwMCIsImF1ZCI6Im5leHVzLXNjYW5uZXIiLCJzY29wZSI6WyJkYXRhIiwiYWkiXSwic3JjIjoibGF1bmNoIiwiaWF0IjoxNzY3MjI1NjAwLCJleHAiOjE3NjcyMjY1MDB9.h2Jr0eqmskCV5qlLqKa01FX9ftHzmBgKm_bxCARj0uUa1pEWTKjxY2SjB8SlWTH0RLwMuoAV5xlcvdzq6S8PBA',
  wrongAudience: 'eyJ2IjoxLCJraWQiOiJ0ZXN0LTEiLCJzdWIiOiJjMGZmZWUwMGMwZmZlZTAwYzBmZmVlMDBjMGZmZWUwMCIsImF1ZCI6Im90aGVyIiwic2NvcGUiOlsiZGF0YSIsImFpIl0sInNyYyI6ImxhdW5jaCIsImlhdCI6MTc2NzIyNTYwMCwiZXhwIjo0MTAyNDQ0ODAwfQ.-B0kFUnfL1nykRSzrqP35z1kghOAEPHtaUBHR1nxOXUaOx-K-1pJwrfpqoXVeewKCNA1WwxnANVXEc7rt4cnCg',
  dataOnly: 'eyJ2IjoxLCJraWQiOiJ0ZXN0LTEiLCJzdWIiOiJjMGZmZWUwMGMwZmZlZTAwYzBmZmVlMDBjMGZmZWUwMCIsImF1ZCI6Im5leHVzLXNjYW5uZXIiLCJzY29wZSI6WyJkYXRhIl0sInNyYyI6ImxhdW5jaCIsImlhdCI6MTc2NzIyNTYwMCwiZXhwIjo0MTAyNDQ0ODAwfQ.FQbh0z3Dq63wyr4WqWV-HiwOM_sHLvn65QOMUQmpJM_1FIVViF1J1nLKQu1gqKNpANYa0pxQoRJhuxGpktlTCg',
};
const tamper = (token) => token.slice(0, -4) + (token.endsWith('AAAA') ? 'BBBB' : 'AAAA');

function gate(path, { mode, token, cookie, method = 'GET', limits = {} } = {}) {
  const forwarded = [];
  const limiterCalls = [];
  const limiter = (name) => ({ async limit({ key }) { limiterCalls.push([name, key]); return { success: limits[name] !== false }; } });
  const headers = { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(cookie ? { Cookie: cookie } : {}) };
  const gateEnv = { ...env, AUTH_MODE: mode, SCANNER_TOKEN_PUBLIC_KEYS: PUBLIC_KEYS,
    DELIVERY_RATE_LIMITER: limiter('delivery'), SNAPSHOT_RATE_LIMITER: limiter('snapshot') };
  const result = gateway(new Request(`https://data.example.com/${path}`, { method, headers }), gateEnv, async (request) => {
    forwarded.push(request);
    return new Response('cached bytes', { headers: { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=31536000, immutable' } });
  });
  return { result, forwarded, limiterCalls };
}

test('answers CORS preflights for the Authorization header without forwarding', async () => {
  const { result, forwarded } = gate('objects/abc.json.gz', { mode: 'enforce', method: 'OPTIONS' });
  const response = await result;
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('Access-Control-Allow-Headers'), 'Authorization');
  assert.equal(response.headers.get('Access-Control-Max-Age'), '86400');
  assert.equal(forwarded.length, 0);
});

test('off and report modes serve everyone, report checks the token', async () => {
  for (const mode of ['off', 'report', undefined]) {
    for (const token of [undefined, TOKENS.expired, 'garbage']) {
      const { result, forwarded } = gate('releases/abc/index.json', { mode, token });
      assert.equal((await result).status, 200, `${mode} ${token}`);
      assert.equal(forwarded.length, 1);
    }
  }
});

test('enforce refuses missing, expired, tampered and foreign tokens with a readable 401', async () => {
  for (const [token, reason] of [[undefined, 'missing'], [TOKENS.expired, 'expired'], [tamper(TOKENS.valid), 'signature'],
    [TOKENS.wrongAudience, 'audience'], ['not-a-token', 'malformed']]) {
    const { result, forwarded } = gate('objects/abc.json.gz', { mode: 'enforce', token });
    const response = await result;
    assert.equal(response.status, 401, reason);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*');
    assert.equal((await response.json()).reason, reason);
    assert.equal(forwarded.length, 0);
  }
});

test('enforce forwards a valid data token without the Authorization header', async () => {
  for (const token of [TOKENS.valid, TOKENS.dataOnly]) {
    const { result, forwarded } = gate('objects/abc.json.gz', { mode: 'enforce', token });
    assert.equal(await (await result).text(), 'cached bytes');
    assert.equal(forwarded[0].headers.get('Authorization'), null);
    assert.equal(forwarded[0].url, 'https://data.example.com/objects/abc.json.gz');
  }
});

test('limits each account, with a separate limit for session history', async () => {
  const objects = gate('objects/abc.json.gz', { mode: 'enforce', token: TOKENS.valid });
  await objects.result;
  const snapshots = gate('snapshots/2026-10-23.json.gz', { mode: 'enforce', token: TOKENS.valid, limits: { snapshot: false } });
  const response = await snapshots.result;
  assert.deepEqual(objects.limiterCalls, [['delivery', 'c0ffee00c0ffee00c0ffee00c0ffee00']]);
  assert.deepEqual(snapshots.limiterCalls, [['snapshot', 'c0ffee00c0ffee00c0ffee00c0ffee00']]);
  assert.equal(response.status, 429);
  assert.equal(snapshots.forwarded.length, 0);
});

test('an unconfigured key set fails closed in enforce mode', async () => {
  const response = await gateway(new Request('https://data.example.com/objects/abc.json.gz', { headers: { Authorization: `Bearer ${TOKENS.valid}` } }),
    { ...env, AUTH_MODE: 'enforce', SCANNER_TOKEN_PUBLIC_KEYS: '{}' }, async () => new Response('cached bytes'));
  assert.equal(response.status, 401);
  assert.equal((await response.json()).reason, 'unknown_key');
});

test('reads the token from the nexus_scanner cookie (the Journal\'s same-site rewrite) and never forwards it', async () => {
  const cookie = `nexus_gsession=abc; nexus_scanner=${TOKENS.valid}; theme=dark`;
  const { result, forwarded } = gate('objects/abc.json.gz', { mode: 'enforce', cookie });
  assert.equal((await result).status, 200);
  assert.equal(forwarded[0].headers.get('Cookie'), null);
  const expired = gate('objects/abc.json.gz', { mode: 'enforce', cookie: `nexus_scanner=${TOKENS.expired}` });
  assert.equal((await (await expired.result).json()).reason, 'expired');
  const other = gate('objects/abc.json.gz', { mode: 'enforce', cookie: 'nexus_gsession=abc' });
  assert.equal((await (await other.result).json()).reason, 'missing');
});

test('the Authorization header wins over the cookie', async () => {
  const { result } = gate('objects/abc.json.gz', { mode: 'enforce', token: TOKENS.expired, cookie: `nexus_scanner=${TOKENS.valid}` });
  assert.equal((await (await result).json()).reason, 'expired');
});

test('gated responses are private to shared caches (Vercel\'s CDN), unchanged while off', async () => {
  for (const mode of ['report', 'enforce']) {
    const { result } = gate('objects/abc.json.gz', { mode, token: TOKENS.valid });
    assert.equal((await result).headers.get('Cache-Control'), 'private, max-age=31536000, immutable', mode);
  }
  const { result } = gate('objects/abc.json.gz', { mode: 'off' });
  assert.equal((await result).headers.get('Cache-Control'), 'public, max-age=31536000, immutable');
});
