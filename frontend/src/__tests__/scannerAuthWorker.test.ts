import {describe, expect, it} from 'vitest';
// The gate module, not workers/screener-ai/index.ts: index.ts needs Worker type globals the frontend build lacks.
import {gateAskAi, serveGatedData} from '../../../workers/screener-ai/scannerGate';
import {corsHeaders} from '../../../workers/screener-ai/cors';

// Test-only key and tokens shared with nexus-journal-api's signer (cf-workers/src/utils/scannerToken.test.ts there).
const PUBLIC_KEYS = JSON.stringify({'test-1': '6kpsY-KcUgq-9VB7Ey7F-ZVHdq6-vnuSQh7qaRRG0iw'});
const VALID = 'eyJ2IjoxLCJraWQiOiJ0ZXN0LTEiLCJzdWIiOiJjMGZmZWUwMGMwZmZlZTAwYzBmZmVlMDBjMGZmZWUwMCIsImF1ZCI6Im5leHVzLXNjYW5uZXIiLCJzY29wZSI6WyJkYXRhIiwiYWkiXSwic3JjIjoibGF1bmNoIiwiaWF0IjoxNzY3MjI1NjAwLCJleHAiOjQxMDI0NDQ4MDB9.D0lyBf0BvLu2H5eYKLEK8VR6s5Gcq3OqIc4oKrqxmghGyIijh8p_Dmo05Dm3V9Dy4JxjzKT2PSrh1gbkBlriAw';
const EXPIRED = 'eyJ2IjoxLCJraWQiOiJ0ZXN0LTEiLCJzdWIiOiJjMGZmZWUwMGMwZmZlZTAwYzBmZmVlMDBjMGZmZWUwMCIsImF1ZCI6Im5leHVzLXNjYW5uZXIiLCJzY29wZSI6WyJkYXRhIiwiYWkiXSwic3JjIjoibGF1bmNoIiwiaWF0IjoxNzY3MjI1NjAwLCJleHAiOjE3NjcyMjY1MDB9.h2Jr0eqmskCV5qlLqKa01FX9ftHzmBgKm_bxCARj0uUa1pEWTKjxY2SjB8SlWTH0RLwMuoAV5xlcvdzq6S8PBA';
const DATA_ONLY = 'eyJ2IjoxLCJraWQiOiJ0ZXN0LTEiLCJzdWIiOiJjMGZmZWUwMGMwZmZlZTAwYzBmZmVlMDBjMGZmZWUwMCIsImF1ZCI6Im5leHVzLXNjYW5uZXIiLCJzY29wZSI6WyJkYXRhIl0sInNyYyI6ImxhdW5jaCIsImlhdCI6MTc2NzIyNTYwMCwiZXhwIjo0MTAyNDQ0ODAwfQ.FQbh0z3Dq63wyr4WqWV-HiwOM_sHLvn65QOMUQmpJM_1FIVViF1J1nLKQu1gqKNpANYa0pxQoRJhuxGpktlTCg';
const SUB = 'c0ffee00c0ffee00c0ffee00c0ffee00';
const ORIGIN = 'https://nexus-scanner.example.workers.dev';

function setup(mode: string | undefined, limits: {data?: boolean} = {}) {
  const limited: string[] = [];
  const object = () => ({httpEtag: '"e"', writeHttpMetadata(headers: Headers) { headers.set('Content-Type', 'application/json'); },
    body: new Response('{"revision":"x"}').body!});
  const bucket = {async get() { return object(); }, async head() { return object(); }};
  const env = {AUTH_MODE: mode, SCANNER_TOKEN_PUBLIC_KEYS: PUBLIC_KEYS,
    DATA_RATE_LIMITER: {async limit({key}: {key: string}) { limited.push(key); return {success: limits.data !== false}; }}};
  const data = (headers: Record<string, string> = {}, method = 'GET') =>
    serveGatedData(new Request(`${ORIGIN}/data/current.json`, {method, headers}), env, bucket);
  const ai = (headers: Record<string, string> = {}) =>
    gateAskAi(new Request(`${ORIGIN}/api/screener/ai-compile`, {method: 'POST', headers: {'CF-Connecting-IP': '203.0.113.9', ...headers}}), env, {'Access-Control-Allow-Origin': 'https://www.nexusjournal.co.in'});
  return {data, ai, limited};
}
const bearer = (token: string) => ({Authorization: `Bearer ${token}`});

describe('/data behind the Scanner token', () => {
  it('answers preflights for Authorization', async () => {
    const response = await setup('enforce').data({}, 'OPTIONS');
    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Headers')).toBe('Authorization');
    expect(response.headers.get('Access-Control-Max-Age')).toBe('86400');
  });

  it('serves everyone while off or reporting', async () => {
    for (const mode of [undefined, 'off', 'report']) {
      expect((await setup(mode).data()).status, String(mode)).toBe(200);
      expect((await setup(mode).data(bearer(EXPIRED))).status, String(mode)).toBe(200);
    }
  });

  it('refuses missing or expired tokens when enforcing, with CORS so the browser can read why', async () => {
    for (const [headers, reason] of [[{}, 'missing'], [bearer(EXPIRED), 'expired']] as const) {
      const response = await setup('enforce').data(headers);
      expect(response.status).toBe(401);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
      await expect(response.json()).resolves.toMatchObject({reason});
    }
  });

  it('serves a valid token and limits by account', async () => {
    const {data, limited} = setup('enforce');
    expect((await data(bearer(DATA_ONLY))).status).toBe(200);
    expect(limited).toEqual([SUB]);
    expect((await setup('enforce', {data: false}).data(bearer(VALID))).status).toBe(429);
  });
});

describe('the token as the nexus_scanner cookie (the Journal reaches these Workers through its own domain)', () => {
  it('is accepted for data and Ask AI, among the Journal\'s other cookies', async () => {
    const {data, ai} = setup('enforce');
    const cookie = {Cookie: `nexus_gsession=abc; nexus_scanner=${VALID}`};
    expect((await data(cookie)).status).toBe(200);
    expect(await ai(cookie)).toEqual({rateKey: `sub:${SUB}`});
  });

  it('keeps gated data out of shared caches while checking, not while off', async () => {
    expect((await setup('enforce').data({Cookie: `nexus_scanner=${VALID}`})).headers.get('Cache-Control')).toBe('private, no-cache');
    expect((await setup('report').data()).headers.get('Cache-Control')).toBe('private, no-cache');
    expect((await setup('off').data()).headers.get('Cache-Control')).toBe('no-cache');
  });
});

describe('Ask AI behind the Scanner token', () => {
  it('allows the Authorization header in its CORS preflight', () => {
    expect(corsHeaders('https://www.nexusjournal.co.in')['Access-Control-Allow-Headers']).toBe('Content-Type, Authorization');
  });

  it('refuses a request without a token once enforcing, with the caller\'s CORS headers', async () => {
    const gate = await setup('enforce').ai();
    expect('denied' in gate && gate.denied.status).toBe(401);
    expect('denied' in gate && gate.denied.headers.get('Access-Control-Allow-Origin')).toBe('https://www.nexusjournal.co.in');
  });

  it('needs the ai scope, not just data', async () => {
    const gate = await setup('enforce').ai(bearer(DATA_ONLY));
    expect('denied' in gate).toBe(true);
    if ('denied' in gate) await expect(gate.denied.json()).resolves.toMatchObject({reason: 'scope'});
  });

  it('limits per account with a valid token, per address otherwise', async () => {
    expect(await setup('enforce').ai(bearer(VALID))).toEqual({rateKey: `sub:${SUB}`});
    expect(await setup('report').ai()).toEqual({rateKey: '203.0.113.9'});
    expect(await setup(undefined).ai(bearer(VALID))).toEqual({rateKey: '203.0.113.9'});
  });
});
