const prefixes = /^(?:objects|releases|daily|monthly|snapshots)\//;

export default {
  async fetch(request, env) {
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

    const object = request.method === 'HEAD' ? await env.DATA.head(key) : await env.DATA.get(key);
    if (!object) return new Response(null, { status: 404, headers: cors });

    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set('ETag', object.httpEtag);
    headers.set('Cache-Control', 'public, max-age=31536000, immutable');
    headers.set('Access-Control-Allow-Origin', '*');
    headers.set('Access-Control-Expose-Headers', 'Content-Encoding');
    headers.set('X-Content-Type-Options', 'nosniff');
    return new Response(request.method === 'HEAD' ? null : object.body, { headers });
  },
};
