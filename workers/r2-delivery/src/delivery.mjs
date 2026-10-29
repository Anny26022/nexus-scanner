import { authMode, denial, logAuth, verifyScannerToken } from '../../auth/scannerToken.mjs';

const PREFLIGHT = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization',
  // Browsers cap this (Chrome at 2 hours); each data URL is preflighted at most that often.
  'Access-Control-Max-Age': '86400',
};

const prefixes = /^(?:objects|releases|daily|monthly|snapshots)\//;

/** Serves one published object. Runs behind Workers Cache (the CachedDelivery entrypoint in index.mjs). */
export async function serveObject(request, env) {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response(null, { status: 405, headers: { ...cors, Allow: 'GET, HEAD' } });
  }
  let key, url;
  try {
    url = new URL(request.url);
    key = decodeURIComponent(url.pathname.slice(1));
  } catch {
    return new Response(null, { status: 400, headers: cors });
  }
  if (!prefixes.test(key) || key.length > 1024 || key.split('/').some(part => !part || part === '.' || part === '..')) {
    return new Response(null, { status: 404, headers: cors });
  }

  const object = request.method === 'HEAD' ? await env.DATA.head(key) : await env.DATA.get(key);
  if (!object) return new Response(null, { status: 404, headers: cors });

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  // Older backfills stored gzip with Content-Encoding, which made the runtime gzip it again. Serve the
  // stored bytes as a gzip file, like every other archive; readers gunzip it themselves.
  if (object.httpMetadata?.contentEncoding === 'gzip') {
    headers.delete('Content-Encoding');
    headers.set('Content-Type', 'application/gzip');
  }
  headers.set('ETag', object.httpEtag);
  // Only content-addressed objects, frozen releases and rotation history (named by hash) are immutable.
  // A session snapshot is immutable once archived, so its URL is too when it names the revision it expects.
  const versioned = /^snapshots\/[^/]+\.json\.gz$/.test(key) && /^[a-f0-9]{16}$/.test(url.searchParams.get('v') ?? '');
  headers.set('Cache-Control', versioned || /^(objects|releases|daily\/rotation)\//.test(key)
    ? 'public, max-age=31536000, immutable' : 'no-cache');
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('X-Content-Type-Options', 'nosniff');
  return new Response(request.method === 'HEAD' ? null : object.body, { headers });
}

/**
 * The uncached front door: checks the Scanner token (AUTH_MODE), limits each account, then forwards to the cached
 * entrypoint. Workers Cache answers before a cached entrypoint runs, so access must be decided here, never there.
 */
export async function gateway(request, env, forward) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: PREFLIGHT });
  const mode = authMode(env);
  if (mode !== 'off') {
    const result = await verifyScannerToken(request, env, 'data');
    logAuth(result, mode, 'delivery');
    const denied = denial(result, mode, { 'Access-Control-Allow-Origin': '*' });
    if (denied) return denied;
    if (result.status === 'valid') {
      // Session history is the bulk-download path, so it has its own, lower limit.
      const limiter = new URL(request.url).pathname.startsWith('/snapshots/') ? env.SNAPSHOT_RATE_LIMITER : env.DELIVERY_RATE_LIMITER;
      if (limiter && !(await limiter.limit({ key: result.payload.sub })).success) {
        return new Response(JSON.stringify({ error: 'Too many requests. Please slow down.' }), {
          status: 429, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*', 'Retry-After': '60' },
        });
      }
    }
  }
  // The token must not reach the cached entrypoint: Authorization makes the cache bypass, and it must never become
  // part of a cache key. Every account receives the same published bytes.
  const forwarded = new Request(request);
  forwarded.headers.delete('Authorization');
  return forward(forwarded);
}
