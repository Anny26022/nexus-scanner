import {expect, it} from 'vitest';
import {checkOrigin, corsHeaders, parseAllowedOrigins, withCors} from '../../../workers/screener-ai/cors';

const endpoint = 'https://nexus-scanner.example.workers.dev/api/screener/ai-compile';
const journal = 'https://www.nexusjournal.co.in';
const allowed = parseAllowedOrigins(` ${journal}, https://nexusjournal.co.in/ ,, * `);
const request = (origin?: string, method = 'POST') => new Request(endpoint, {method, headers: origin ? {Origin: origin} : {}});

it('parses an exact origin list and never treats * as a wildcard', () => {
  expect([...allowed]).toEqual([journal, 'https://nexusjournal.co.in']);
  expect(parseAllowedOrigins(undefined).size).toBe(0);
});

it('keeps same-origin and Origin-less requests working without CORS headers', () => {
  expect(checkOrigin(request(), allowed)).toEqual({allowed: true});
  expect(checkOrigin(request('https://nexus-scanner.example.workers.dev'), new Set())).toEqual({allowed: true});
});

it('allows only listed cross-origin callers', () => {
  expect(checkOrigin(request(journal), allowed)).toEqual({allowed: true, corsOrigin: journal});
  expect(checkOrigin(request('https://evil.example'), allowed)).toEqual({allowed: false});
  expect(checkOrigin(request('https://www.nexusjournal.co.in.evil.example'), allowed)).toEqual({allowed: false});
  expect(checkOrigin(request(journal), new Set())).toEqual({allowed: false});
});

it('echoes the allowed origin on responses, including errors, and varies on Origin', async () => {
  const response = withCors(Response.json({error: 'Too many requests.'}, {status: 429}), {allowed: true, corsOrigin: journal});
  expect(response.status).toBe(429);
  expect(response.headers.get('Access-Control-Allow-Origin')).toBe(journal);
  expect(response.headers.get('Vary')).toBe('Origin');
  expect(await response.json()).toEqual({error: 'Too many requests.'});
  const same = withCors(Response.json({}), {allowed: true});
  expect(same.headers.get('Access-Control-Allow-Origin')).toBeNull();
});

it('answers preflight with the methods and headers the app sends', () => {
  const headers = corsHeaders(journal);
  expect(headers['Access-Control-Allow-Methods']).toContain('POST');
  expect(headers['Access-Control-Allow-Headers']).toBe('Content-Type');
});

it('matches a suffix entry for branch previews, and nothing broader', () => {
  const previews = parseAllowedOrigins('https://*-team-projects.vercel.app, https://*, https://*.app, *, http://*-x.example.com');
  expect([...previews]).toEqual(['https://*-team-projects.vercel.app']);
  const allowed = (origin: string) => checkOrigin(request(origin), previews).allowed;
  expect(allowed('https://new-nexys-ulti-git-1bd98f-team-projects.vercel.app')).toBe(true);
  expect(allowed('https://-team-projects.vercel.app')).toBe(false);
  expect(allowed('https://evil.vercel.app')).toBe(false);
  expect(allowed('https://x-team-projects.vercel.app.evil.example')).toBe(false);
  expect(allowed('http://x-team-projects.vercel.app')).toBe(false);
  expect(allowed('https://x-team-projects.vercel.app:8443')).toBe(false);
  expect(allowed('null')).toBe(false);
});
