import {describe, expect, it} from 'vitest';
// The gate module, not workers/screener-ai/index.ts: index.ts needs Worker type globals the frontend build lacks.
import {gateAskAi, serveGatedData} from '../../../workers/screener-ai/scannerGate';
import {corsHeaders} from '../../../workers/screener-ai/cors';

const SECRET = 'test-gateway-secret';
const USER = 'c0ffee00c0ffee00c0ffee00c0ffee00';
const ORIGIN = 'https://nexus-scanner.example.workers.dev';
// The headers nexus-journal-api forwards with (workers/auth/scannerGateway.mjs).
const fromJournal = (secret = SECRET) => ({'X-Nexus-Gateway': secret, 'X-Nexus-User': USER});

function setup(mode: string | undefined, limits: {data?: boolean} = {}) {
  const limited: string[] = [];
  const object = () => ({httpEtag: '"e"', writeHttpMetadata(headers: Headers) { headers.set('Content-Type', 'application/json'); },
    body: new Response('{"revision":"x"}').body!});
  const bucket = {async get() { return object(); }, async head() { return object(); }};
  const env = {AUTH_MODE: mode, SCANNER_GATEWAY_SECRET: SECRET,
    DATA_RATE_LIMITER: {async limit({key}: {key: string}) { limited.push(key); return {success: limits.data !== false}; }}};
  const data = (headers: Record<string, string> = {}) =>
    serveGatedData(new Request(`${ORIGIN}/data/current.json`, {headers}), env, bucket);
  const ai = (headers: Record<string, string> = {}) =>
    gateAskAi(new Request(`${ORIGIN}/api/screener/ai-compile`, {method: 'POST', headers: {'CF-Connecting-IP': '203.0.113.9', ...headers}}), env, {'Access-Control-Allow-Origin': 'https://www.nexusjournal.co.in'});
  return {data, ai, limited};
}

describe('/data behind the Journal gateway', () => {
  it('serves everyone while off or reporting', async () => {
    for (const mode of [undefined, 'off', 'report']) {
      expect((await setup(mode).data()).status, String(mode)).toBe(200);
      expect((await setup(mode).data(fromJournal('wrong'))).status, String(mode)).toBe(200);
    }
  });

  it('refuses requests that did not come through the Journal when enforcing', async () => {
    for (const [headers, reason] of [[{}, 'missing'], [fromJournal('wrong'), 'secret']] as const) {
      const response = await setup('enforce').data(headers);
      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toMatchObject({reason});
    }
  });

  it('serves a request the Journal forwarded, limited by account, and keeps it out of shared caches', async () => {
    const {data, limited} = setup('enforce');
    const response = await data(fromJournal());
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-cache');
    expect(limited).toEqual([USER]);
    expect((await setup('enforce', {data: false}).data(fromJournal())).status).toBe(429);
  });
});

describe('Ask AI behind the Journal gateway', () => {
  it('needs no extra CORS header: browsers do not call it with credentials', () => {
    expect(corsHeaders('https://www.nexusjournal.co.in')['Access-Control-Allow-Headers']).toBe('Content-Type');
  });

  it('refuses a request without the gateway once enforcing, with the caller\'s CORS headers', async () => {
    const result = await setup('enforce').ai();
    expect('denied' in result && result.denied.status).toBe(401);
    expect('denied' in result && result.denied.headers.get('Access-Control-Allow-Origin')).toBe('https://www.nexusjournal.co.in');
  });

  it('limits per account through the Journal, per address otherwise', async () => {
    expect(await setup('enforce').ai(fromJournal())).toEqual({rateKey: `user:${USER}`});
    expect(await setup('report').ai()).toEqual({rateKey: '203.0.113.9'});
    expect(await setup(undefined).ai(fromJournal())).toEqual({rateKey: '203.0.113.9'});
  });
});
