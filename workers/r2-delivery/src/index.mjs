const prefixes = /^(?:objects|releases|daily|monthly|snapshots)\//;

export default {
  async fetch(request, env) {
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
    headers.set('ETag', object.httpEtag);
    // Only content-addressed objects, frozen releases and rotation history (named by hash) are immutable.
    // A session snapshot is immutable once archived, so its URL is too when it names the revision it expects.
    const versioned = /^snapshots\/[^/]+\.json\.gz$/.test(key) && /^[a-f0-9]{16}$/.test(url.searchParams.get('v') ?? '');
    headers.set('Cache-Control', versioned || /^(objects|releases|daily\/rotation)\//.test(key)
      ? 'public, max-age=31536000, immutable' : 'no-cache');
    headers.set('Access-Control-Allow-Origin', '*');
    // Lets cross-origin readers tell a body the browser already decoded from one they must gunzip.
    headers.set('Access-Control-Expose-Headers', 'Content-Encoding');
    headers.set('X-Content-Type-Options', 'nosniff');
    // An object stored with Content-Encoding is already encoded: send its bytes as they are, not compressed again.
    const encodeBody = object.httpMetadata?.contentEncoding ? 'manual' : 'automatic';
    return new Response(request.method === 'HEAD' ? null : object.body, { headers, encodeBody });
  },
};
