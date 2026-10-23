const prefixes = /^(?:objects|releases|daily|monthly|snapshots)\//;

export default {
  async fetch(request, env, ctx) {
    const cors = { 'Access-Control-Allow-Origin': '*' };
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response(null, { status: 405, headers: { ...cors, Allow: 'GET, HEAD' } });
    }
    let key;
    try {
      key = decodeURIComponent(new URL(request.url).pathname.slice(1));
    } catch {
      return new Response(null, { status: 400, headers: cors });
    }
    if (!prefixes.test(key) || key.length > 1024 || key.split('/').some(part => !part || part === '.' || part === '..')) {
      return new Response(null, { status: 404, headers: cors });
    }

    // Published files never change, so the edge cache answers repeat reads without a trip to R2 (~500ms).
    const cache = request.method === 'GET' && typeof caches !== 'undefined' ? caches.default : null;
    const hit = cache && await cache.match(request);
    if (hit) return hit;

    const object = request.method === 'HEAD' ? await env.DATA.head(key) : await env.DATA.get(key);
    if (!object) return new Response(null, { status: 404, headers: cors });

    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set('ETag', object.httpEtag);
    headers.set('Cache-Control', 'public, max-age=31536000, immutable');
    headers.set('Access-Control-Allow-Origin', '*');
    headers.set('X-Content-Type-Options', 'nosniff');
    const response = new Response(request.method === 'HEAD' ? null : object.body, { headers });
    if (cache && ctx) ctx.waitUntil(cache.put(request, response.clone()));
    return response;
  },
};
