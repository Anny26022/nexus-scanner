/** Response helpers for the markdown and discovery endpoints. */
export const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Accept, Content-Type',
} as const;

/** Advertised on every HTML page the Worker serves. */
export const DESCRIBED_BY = '</llms.txt>; rel="describedby"; type="text/plain", </llms-full.txt>; rel="describedby"; type="text/plain", '
  + '</ai.txt>; rel="describedby"; type="text/plain"';

export function markdownResponse(request: Request, body: string, options: {
  status?: number; canonical?: string; lastModified?: string; negotiated?: boolean; maxAge?: number;
} = {}): Response {
  const headers = new Headers({
    ...CORS,
    'Content-Type': 'text/markdown; charset=utf-8',
    'X-Markdown-Tokens': String(Math.ceil(body.length / 4)),
    'X-Robots-Tag': 'noindex, follow',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': options.status === 404 ? 'public, max-age=300'
      : `public, s-maxage=${options.maxAge ?? 3600}, stale-while-revalidate=86400`,
  });
  if (options.canonical) {
    headers.set('Content-Location', options.canonical);
    headers.set('Link', `<${options.canonical}>; rel="canonical"`);
  }
  if (options.lastModified) headers.set('Last-Modified', new Date(`${options.lastModified}T00:00:00Z`).toUTCString());
  if (options.negotiated) headers.set('Vary', 'Accept');
  return new Response(request.method === 'HEAD' ? null : body, {status: options.status ?? 200, headers});
}

export function textResponse(request: Request, body: string, maxAge = 86400, type = 'text/plain'): Response {
  return new Response(request.method === 'HEAD' ? null : body, {headers: {
    ...CORS,
    'Content-Type': `${type}; charset=utf-8`,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': `public, s-maxage=${maxAge}, stale-while-revalidate=${maxAge * 7}`,
  }});
}

export const preflight = () => new Response(null, {status: 204, headers: {...CORS, 'Access-Control-Max-Age': '86400'}});

/**
 * True when the client asks for markdown with a higher q than for HTML. A missing Accept, a bare `*\/*` or a tie
 * means HTML, so browsers, curl and link previews are unaffected; a wildcard fallback next to text/markdown does not
 * count as asking for HTML.
 */
export function prefersMarkdown(accept: string | null): boolean {
  if (!accept) return false;
  let markdown = 0, html = 0;
  for (const part of accept.split(',')) {
    const [type, ...params] = part.trim().toLowerCase().split(';').map(item => item.trim());
    const q = Number(params.find(param => param.startsWith('q='))?.slice(2) ?? 1);
    const weight = Number.isFinite(q) ? q : 0;
    if (type === 'text/markdown' || type === 'text/x-markdown') markdown = Math.max(markdown, weight);
    if (type === 'text/html' || type === 'application/xhtml+xml') html = Math.max(html, weight);
  }
  return markdown > html;
}
