import { DESCRIBED_BY, PAGE_VARY } from './http';
import type { MarkdownRoute } from './registry';
import { SITE, absolute, markdownPath } from './site';

type Assets = { fetch(request: Request): Promise<Response> };

const escapeAttr = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/** The app's HTML for a page, with that page's title, summary, canonical, markdown alternate and (home) JSON-LD. */
export async function htmlPage(request: Request, assets: Assets, route: MarkdownRoute): Promise<Response> {
  const page = await assets.fetch(new Request(new URL('/', request.url), request));
  const title = route.path === '/' ? `${SITE.name} — NSE equity screener, market breadth, earnings and rotation` : `${route.title} | ${SITE.name}`; // matches sectionTitle in the app
  const jsonLd = route.path === '/' ? JSON.stringify({'@context': 'https://schema.org', '@graph': [
    {'@type': 'Organization', '@id': `${SITE.url}/#organization`, name: SITE.name, url: SITE.url, logo: absolute(SITE.logo),
      sameAs: [SITE.repository], contactPoint: {'@type': 'ContactPoint', contactType: 'support', url: SITE.contact}},
    {'@type': 'WebSite', '@id': `${SITE.url}/#website`, name: SITE.name, url: SITE.url, description: SITE.description,
      publisher: {'@id': `${SITE.url}/#organization`}},
  ]}).replace(/</g, '\\u003c') : null;
  const head = [
    `<meta name="description" content="${escapeAttr(route.summary)}">`,
    `<meta name="ai-summary" content="${escapeAttr(route.summary)}">`,
    `<link rel="canonical" href="${absolute(route.path)}">`,
    `<link rel="alternate" type="text/markdown" href="${absolute(markdownPath(route.path))}">`,
    jsonLd ? `<script type="application/ld+json">${jsonLd}</script>` : '',
  ].join('');
  const rewritten = new HTMLRewriter()
    .on('title', {element: element => { element.setInnerContent(title); }})
    .on('head', {element: element => { element.append(head, {html: true}); }})
    .transform(page);
  const headers = new Headers(rewritten.headers);
  headers.append('Link', `<${absolute(markdownPath(route.path))}>; rel="alternate"; type="text/markdown"`);
  headers.append('Link', DESCRIBED_BY);
  headers.append('Vary', PAGE_VARY);
  return new Response(request.method === 'HEAD' ? null : rewritten.body, {status: page.status, headers});
}

