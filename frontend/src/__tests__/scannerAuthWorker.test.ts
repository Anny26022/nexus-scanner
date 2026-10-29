import {describe, expect, it} from 'vitest';
import worker from '../../../workers/screener-ai/index';

// Test-only key and tokens shared with nexus-journal-api's signer (cf-workers/src/utils/scannerToken.test.ts there).
const PUBLIC_KEYS = JSON.stringify({'test-1': '6kpsY-KcUgq-9VB7Ey7F-ZVHdq6-vnuSQh7qaRRG0iw'});
const VALID = 'eyJ2IjoxLCJraWQiOiJ0ZXN0LTEiLCJzdWIiOiJjMGZmZWUwMGMwZmZlZTAwYzBmZmVlMDBjMGZmZWUwMCIsImF1ZCI6Im5leHVzLXNjYW5uZXIiLCJzY29wZSI6WyJkYXRhIiwiYWkiXSwic3JjIjoibGF1bmNoIiwiaWF0IjoxNzY3MjI1NjAwLCJleHAiOjQxMDI0NDQ4MDB9.D0lyBf0BvLu2H5eYKLEK8VR6s5Gcq3OqIc4oKrqxmghGyIijh8p_Dmo05Dm3V9Dy4JxjzKT2PSrh1gbkBlriAw';
const EXPIRED = 'eyJ2IjoxLCJraWQiOiJ0ZXN0LTEiLCJzdWIiOiJjMGZmZWUwMGMwZmZlZTAwYzBmZmVlMDBjMGZmZWUwMCIsImF1ZCI6Im5leHVzLXNjYW5uZXIiLCJzY29wZSI6WyJkYXRhIiwiYWkiXSwic3JjIjoibGF1bmNoIiwiaWF0IjoxNzY3MjI1NjAwLCJleHAiOjE3NjcyMjY1MDB9.h2Jr0eqmskCV5qlLqKa01FX9ftHzmBgKm_bxCARj0uUa1pEWTKjxY2SjB8SlWTH0RLwMuoAV5xlcvdzq6S8PBA';
const DATA_ONLY = 'eyJ2IjoxLCJraWQiOiJ0ZXN0LTEiLCJzdWIiOiJjMGZmZWUwMGMwZmZlZTAwYzBmZmVlMDBjMGZmZWUwMCIsImF1ZCI6Im5leHVzLXNjYW5uZXIiLCJzY29wZSI6WyJkYXRhIl0sInNyYyI6ImxhdW5jaCIsImlhdCI6MTc2NzIyNTYwMCwiZXhwIjo0MTAyNDQ0ODAwfQ.FQbh0z3Dq63wyr4WqWV-HiwOM_sHLvn65QOMUQmpJM_1FIVViF1J1nLKQu1gqKNpANYa0pxQoRJhuxGpktlTCg';
const SUB = 'c0ffee00c0ffee00c0ffee00c0ffee00';
const JOURNAL = 'https://www.nexusjournal.co.in';

function setup(mode: string | undefined, limits: {data?: boolean; ai?: boolean} = {}) {
  const limited: Array<[string, string]> = [];
  const object = {httpEtag: '"e"', writeHttpMetadata(headers: Headers) { headers.set('Content-Type', 'application/json'); },
    body: new Response('{"revision":"x"}').body};
  const env = {
    AUTH_MODE: mode,
    SCANNER_TOKEN_PUBLIC_KEYS: PUBLIC_KEYS,
    ALLOWED_ORIGINS: JOURNAL,
    DATA: {async get() { return {...object, body: new Response('{"revision":"x"}').body}; }, async head() { return object; }},
    DATA_RATE_LIMITER: {async limit({key}: {key: string}) { limited.push(['data', key]); return {success: limits.data !== false}; }},
    AI_RATE_LIMITER: {async limit({key}: {key: string}) { limited.push(['ai', key]); return {success: limits.ai !== false}; }},
  };
  const call = (path: string, init: RequestInit = {}) =>
    worker.fetch(new Request(`https://nexus-scanner.example.workers.dev${path}`, init) as never, env as never, {waitUntil() {}} as never);
  return {call, limited};
}
const bearer = (token: string) => ({Authorization: `Bearer ${token}`});
const askAi = (headers: Record<string, string>) => ({method: 'POST', body: JSON.stringify({text: 'RSI above 60'}),
  headers: {'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.9', Origin: JOURNAL, ...headers}});

describe('/data behind the Scanner token', () => {
  it('answers preflights for Authorization', async () => {
    const response = await setup('enforce').call('/data/current.json', {method: 'OPTIONS'});
    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Headers')).toBe('Authorization');
    expect(response.headers.get('Access-Control-Max-Age')).toBe('86400');
  });

  it('serves everyone while off or reporting', async () => {
    for (const mode of [undefined, 'off', 'report']) {
      expect((await setup(mode).call('/data/current.json')).status, String(mode)).toBe(200);
      expect((await setup(mode).call('/data/current.json', {headers: bearer(EXPIRED)})).status, String(mode)).toBe(200);
    }
  });

  it('refuses missing or expired tokens when enforcing, with CORS so the browser can read why', async () => {
    for (const [headers, reason] of [[{}, 'missing'], [bearer(EXPIRED), 'expired']] as const) {
      const response = await setup('enforce').call('/data/current.json', {headers});
      expect(response.status).toBe(401);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
      await expect(response.json()).resolves.toMatchObject({reason});
    }
  });

  it('serves a valid token and limits by account', async () => {
    const {call, limited} = setup('enforce');
    expect((await call('/data/current.json', {headers: bearer(DATA_ONLY)})).status).toBe(200);
    expect(limited).toEqual([['data', SUB]]);
    expect((await setup('enforce', {data: false}).call('/data/current.json', {headers: bearer(VALID)})).status).toBe(429);
  });
});

describe('Ask AI behind the Scanner token', () => {
  it('allows the Authorization header in its CORS preflight', async () => {
    const response = await setup('enforce').call('/api/screener/ai-compile', {method: 'OPTIONS', headers: {Origin: JOURNAL}});
    expect(response.headers.get('Access-Control-Allow-Headers')).toBe('Content-Type, Authorization');
  });

  it('refuses scripts without a token once enforcing, even without an Origin header', async () => {
    const response = await setup('enforce').call('/api/screener/ai-compile', askAi({Origin: ''}));
    expect(response.status).toBe(401);
  });

  it('needs the ai scope, not just data', async () => {
    const response = await setup('enforce').call('/api/screener/ai-compile', askAi(bearer(DATA_ONLY)));
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({reason: 'scope'});
  });

  it('limits per account with a valid token, per address otherwise', async () => {
    const withToken = setup('enforce', {ai: false});
    expect((await withToken.call('/api/screener/ai-compile', askAi(bearer(VALID)))).status).toBe(429);
    expect(withToken.limited).toEqual([['ai', `sub:${SUB}`]]);
    const reporting = setup('report', {ai: false});
    expect((await reporting.call('/api/screener/ai-compile', askAi({}))).status).toBe(429);
    expect(reporting.limited).toEqual([['ai', '203.0.113.9']]);
  });
});
