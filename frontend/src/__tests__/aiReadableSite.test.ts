import { describe, expect, it } from 'vitest';
import { SECTIONS, sectionForPath } from '../data/sections';
import { prefersMarkdown } from '../../../workers/screener-ai/md/http';
import { MARKDOWN_ROUTES, notFoundMarkdown, routeFor, type Release } from '../../../workers/screener-ai/md/registry';
import { aiTxt, llmsFullTxt, llmsTxt, robotsTxt, sitemapXml } from '../../../workers/screener-ai/md/discovery';
import { handleAgentRequest } from '../../../workers/screener-ai/md/route';
import { SITE } from '../../../workers/screener-ai/md/site';

const release: Release = {sessionDate: '2026-10-23', totalStocks: 2612, recentListings: 66,
  breadth: {advances: 267, declines: 2028, unchanged: 6, new_52w_high: 7, new_52w_low: 385, above_50_pct: 11.59, above_200_pct: 31.63},
  indices: [{name: 'Nifty 50', close: 22600, changePct: -0.3863}]};

describe('AI-readable site', () => {
  it('has a markdown renderer for every public page', () => {
    // A new section without a renderer fails here; skipped pages would need an explicit, explained entry.
    expect(MARKDOWN_ROUTES.map(route => route.path)).toEqual(['/', ...SECTIONS.map(section => section.path)]);
    for (const section of SECTIONS) expect(sectionForPath(`${section.path}/`)).toBe(section);
  });

  it('serves markdown only when it is preferred over HTML', () => {
    expect(prefersMarkdown(null)).toBe(false);
    expect(prefersMarkdown('*/*')).toBe(false);
    expect(prefersMarkdown('text/html,application/xhtml+xml,*/*;q=0.8')).toBe(false);
    expect(prefersMarkdown('text/markdown')).toBe(true);
    expect(prefersMarkdown('text/markdown, */*')).toBe(true);
    expect(prefersMarkdown('text/markdown;q=0.5, text/html')).toBe(false);
    expect(prefersMarkdown('text/markdown, text/html;q=0.9')).toBe(true);
  });

  it('renders pages from the release with absolute links and no invented figures', () => {
    const market = routeFor('/market.md')!.render(release);
    expect(market).toMatch(/^# Market overview \| Nexus Research Screener\n\n> /);
    expect(market).toContain(`Canonical: ${SITE.url}/market`);
    expect(market).toContain('Last updated: 2026-10-23');
    expect(market).toContain('| 267 | 2,028 | 6 | 7 | 385 | 11.6% | 31.6% |');
    expect(market).toContain('| Nifty 50 | 22,600 | -0.39% |');
    expect(market).not.toMatch(/\]\(\/(?!\/)/);
    // Without a release, the page still describes the section and shows no numbers.
    expect(routeFor('/market')!.render(null)).not.toContain('Breadth on');
    expect(routeFor('/index.md')).toBe(MARKDOWN_ROUTES[0]);
    expect(routeFor('/admin.md')).toBeNull();
    expect(notFoundMarkdown('/admin.md')).toContain('# Page not found');
  });

  it('builds llms.txt, llms-full.txt, ai.txt, robots.txt and the sitemap from one config', () => {
    const llms = llmsTxt();
    expect(llms.startsWith(`# ${SITE.name}\n\n> ${SITE.description}`)).toBe(true);
    for (const section of SECTIONS) expect(llms).toContain(`(${SITE.url}${section.path}.md): ${section.summary}`);
    const full = llmsFullTxt(release);
    expect(full.match(/<!-- source: /g)).toHaveLength(MARKDOWN_ROUTES.length);
    expect(full.length).toBeLessThan(500_000);
    expect(aiTxt()).toContain(`name: ${SITE.name}`);
    const robots = robotsTxt();
    for (const bot of ['OAI-SearchBot', 'ChatGPT-User', 'Claude-SearchBot', 'Claude-User', 'PerplexityBot', 'Perplexity-User', 'GPTBot', 'ClaudeBot']) {
      expect(robots).toMatch(new RegExp(`User-agent: ${bot}\\n(User-agent: .+\\n)*Allow: /`));
    }
    expect(robots).toMatch(/User-agent: CCBot\n(User-agent: .+\n)*Disallow: \/\n/);
    expect(robots).toContain(`Sitemap: ${SITE.url}/sitemap.xml`);
    expect(sitemapXml(release)).not.toContain('.md');
  });

  it('routes .md, negotiated and /api/md requests to markdown, leaving other paths alone', async () => {
    const assets = {fetch: async (request: Request) => new URL(request.url).pathname === '/data/current.json'
      ? Response.json({sessionDate: '2026-10-23', totalStocks: 2612}) : new Response('<html><head><title>x</title></head></html>', {status: 404})};
    const get = (path: string, accept?: string) => handleAgentRequest(new Request(`https://nexus.example${path}`, {headers: accept ? {Accept: accept} : {}}), assets);
    const md = (await get('/screener.md')) as Response;
    expect(md.headers.get('Content-Type')).toBe('text/markdown; charset=utf-8');
    expect(md.headers.get('X-Robots-Tag')).toBe('noindex, follow');
    expect(md.headers.get('Content-Location')).toBe(`${SITE.url}/screener`);
    expect(Number(md.headers.get('X-Markdown-Tokens'))).toBeGreaterThan(0);
    expect(await md.text()).toContain('| 2026-10-23 | 2,612 |');
    expect(((await get('/screener', 'text/markdown')) as Response).headers.get('Vary')).toBe('Accept');
    expect(await get('/screener', 'text/html,*/*;q=0.8')).toEqual({page: routeFor('/screener')});
    expect(((await get('/api/md/rotation')) as Response).status).toBe(200);
    const missing = (await get('/does-not-exist.md')) as Response;
    expect([missing.status, missing.headers.get('Content-Type')]).toEqual([404, 'text/markdown; charset=utf-8']);
    expect(await get('/assets/app.js')).toBeNull();
    expect(await get('/api/screener/ai-compile')).toBeNull();
    const head = (await handleAgentRequest(new Request('https://nexus.example/llms.txt', {method: 'HEAD'}), assets)) as Response;
    expect([head.status, head.body, head.headers.get('Content-Type')]).toEqual([200, null, 'text/plain; charset=utf-8']);
  });
});
