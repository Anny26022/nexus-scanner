import { aiTxt, catalogJson, llmsFullTxt, llmsTxt, robotsTxt, sitemapXml } from './discovery';
import { markdownResponse, preflight, prefersMarkdown, textResponse } from './http';
import { loadRelease, notFoundMarkdown, routeFor, type MarkdownRoute, type Release } from './registry';
import { absolute } from './site';

type Assets = { fetch(request: Request): Promise<Response> };

// One read of the latest release per Worker instance and ten minutes; releases change at most daily.
let cached: {at: number; release: Promise<Release | null>} | null = null;
const latestRelease = (assets: Assets, origin: string) => {
  if (!cached || Date.now() - cached.at > 600_000) cached = {at: Date.now(), release: loadRelease(assets, origin)};
  return cached.release;
};

const DISCOVERY: Record<string, (request: Request, release: () => Promise<Release | null>) => Promise<Response>> = {
  '/llms.txt': async request => textResponse(request, llmsTxt()),
  '/llms-full.txt': async (request, release) => textResponse(request, llmsFullTxt(await release())),
  '/ai.txt': async request => textResponse(request, aiTxt()),
  '/robots.txt': async request => textResponse(request, robotsTxt()),
  '/sitemap.xml': async (request, release) => textResponse(request, sitemapXml(await release()), 86400, 'application/xml'),
  '/api/md/_catalog': async request => textResponse(request, catalogJson(), 3600, 'application/json'),
};

async function markdown(request: Request, route: MarkdownRoute | null, path: string, release: () => Promise<Release | null>, negotiated = false) {
  if (!route) return markdownResponse(request, notFoundMarkdown(path), {status: 404});
  const latest = await release();
  return markdownResponse(request, route.render(latest), {canonical: absolute(route.path), lastModified: latest?.sessionDate, negotiated});
}

/**
 * Agent-facing routes: markdown (`/x.md`, `Accept: text/markdown`, `/api/md/x`) and the discovery files. A known page
 * asked for as HTML comes back as `{page}` for `htmlPage`; anything else is null and keeps its normal handling.
 */
export async function handleAgentRequest(request: Request, assets: Assets): Promise<Response | {page: MarkdownRoute} | null> {
  const url = new URL(request.url);
  const path = url.pathname;
  const release = () => latestRelease(assets, url.origin);
  const agentPath = path in DISCOVERY || path.endsWith('.md') || path.startsWith('/api/md/');
  if (request.method === 'OPTIONS' && agentPath) return preflight();
  if (request.method !== 'GET' && request.method !== 'HEAD') return null;
  if (DISCOVERY[path]) return DISCOVERY[path](request, release);
  if (path.startsWith('/api/md/')) {
    const target = `/${path.slice('/api/md/'.length)}`;
    return markdown(request, routeFor(target === '/' ? '/' : target), target, release);
  }
  if (path.endsWith('.md')) return markdown(request, routeFor(path), path, release);
  // Content negotiation only on known pages; every other path keeps its normal handling.
  const route = routeFor(path);
  if (!route || path.endsWith('.md')) return null;
  return prefersMarkdown(request.headers.get('Accept')) ? markdown(request, route, path, release, true) : {page: route};
}
