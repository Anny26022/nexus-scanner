/** Response helpers for the markdown and discovery endpoints. */
export const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Accept, Content-Type',
} as const;

/** Advertised on every HTML page the Worker serves. */
export const DESCRIBED_BY = '</llms.txt>; rel="describedby"; type="text/plain", </llms-full.txt>; rel="describedby"; type="text/plain", '
  + '</ai.txt>; rel="describedby"; type="text/plain"';

/** Every page response depends on Accept, and on User-Agent too because known AI agents are served markdown. */
export const PAGE_VARY = 'Accept, User-Agent';

export function markdownResponse(request: Request, body: string, options: {
  status?: number; canonical?: string; lastModified?: string; maxAge?: number;
} = {}): Response {
  const headers = new Headers({
    ...CORS,
    'Content-Type': 'text/markdown; charset=utf-8',
    'X-Markdown-Tokens': String(Math.ceil(body.length / 4)),
    'X-Robots-Tag': 'noindex, follow',
    'X-Content-Type-Options': 'nosniff',
    'X-AEO-Version': '1.0',
    // Set on every markdown response, .md URLs included, so a shared cache never serves one format for the other.
    'Vary': PAGE_VARY,
    'Cache-Control': options.status === 404 ? 'public, max-age=300'
      : `public, s-maxage=${options.maxAge ?? 3600}, stale-while-revalidate=86400`,
  });
  if (options.canonical) {
    headers.set('Content-Location', options.canonical);
    headers.set('Link', `<${options.canonical}>; rel="canonical"`);
  }
  if (options.lastModified) headers.set('Last-Modified', new Date(`${options.lastModified}T00:00:00Z`).toUTCString());
  return new Response(request.method === 'HEAD' ? null : body, {status: options.status ?? 200, headers});
}

export function textResponse(request: Request, body: string, maxAge = 86400, type = 'text/plain', noindex = false): Response {
  return new Response(request.method === 'HEAD' ? null : body, {headers: {
    ...CORS,
    ...(noindex ? {'X-Robots-Tag': 'noindex'} : {}),
    'Content-Type': `${type}; charset=utf-8`,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': `public, s-maxage=${maxAge}, stale-while-revalidate=${maxAge * 7}`,
  }});
}

export const preflight = () => new Response(null, {status: 204, headers: {...CORS, 'Access-Control-Max-Age': '86400'}});

/** The AI Agent Registry (Dualmark AEO spec v1.0), matched as case-insensitive substrings of User-Agent. */
const AI_AGENTS = ['GPTBot', 'ChatGPT-User', 'OAI-SearchBot', 'ClaudeBot', 'Anthropic-ai', 'Claude-Web', 'Claude-SearchBot', 'Claude-User',
  'PerplexityBot', 'Perplexity-User', 'Google-Extended', 'Applebot-Extended', 'cohere-ai', 'CCBot', 'Bytespider', 'DeepSeekBot',
  'Amazonbot', 'YouBot', 'Diffbot', 'ImagesiftBot', 'Omgilibot', 'DuckAssistBot', 'meta-externalagent', 'meta-externalfetcher']
  .map(agent => agent.toLowerCase());
export const isAiAgent = (userAgent: string | null) => !!userAgent && AI_AGENTS.some(agent => userAgent.toLowerCase().includes(agent));

export type Format = 'html' | 'markdown';

/**
 * Picks HTML or markdown for a page (RFC 7231 Accept, q-values and wildcards), or null for a 406.
 * - No Accept, or a tie, means HTML, so browsers, curl and link previews are unaffected. The exception to a tie is an
 *   Accept that names text/markdown and reaches HTML only through a wildcard (`text/markdown, *\/*`): that asks for markdown.
 * - A known AI agent gets markdown unless its Accept names HTML explicitly; the user agent never overrides that.
 */
export function negotiate(accept: string | null, userAgent: string | null): Format | null {
  const ranges = (accept ?? '').split(',').map(part => {
    const [type, ...params] = part.trim().toLowerCase().split(';').map(item => item.trim());
    const q = Number(params.find(param => param.startsWith('q='))?.slice(2) ?? 1);
    return {type, q: Number.isFinite(q) ? Math.min(1, Math.max(0, q)) : 0};
  }).filter(range => range.type);
  if (!ranges.length) return isAiAgent(userAgent) ? 'markdown' : 'html';
  const named = (types: string[]) => ranges.filter(range => types.includes(range.type));
  const quality = (types: string[]) => {
    // The most specific matching range decides a format's quality.
    const exact = named(types), group = ranges.filter(range => range.type === 'text/*'), any = ranges.filter(range => range.type === '*/*');
    const pick = exact.length ? exact : group.length ? group : any;
    return pick.length ? Math.max(...pick.map(range => range.q)) : 0;
  };
  const htmlTypes = ['text/html', 'application/xhtml+xml'], markdownTypes = ['text/markdown', 'text/x-markdown'];
  const html = quality(htmlTypes), markdown = quality(markdownTypes);
  if (html <= 0 && markdown <= 0) return null;
  const htmlNamed = named(htmlTypes).some(range => range.q > 0), markdownNamed = named(markdownTypes).some(range => range.q > 0);
  if (isAiAgent(userAgent) && !htmlNamed && markdown > 0) return 'markdown';
  if (markdown > html) return 'markdown';
  if (markdown === html && markdownNamed && !htmlNamed) return 'markdown';
  return 'html';
}

export const notAcceptable = (request: Request) => new Response(request.method === 'HEAD' ? null : 'Supported types: text/html, text/markdown\n', {
  status: 406, headers: {...CORS, 'Content-Type': 'text/plain; charset=utf-8', 'Vary': PAGE_VARY, 'X-Content-Type-Options': 'nosniff'},
});
