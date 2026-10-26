/**
 * Site-level files for crawlers and agents. robots.txt, llms.txt and ai.txt describe the same site and the same public
 * and closed paths; keep the three in sync by changing SITE, MARKDOWN_ROUTES, NOT_PAGES or CRAWL_RULES, never the text.
 */
import { MARKDOWN_ROUTES, listMarkdownRoutes, type Release } from './registry';
import { SITE, absolute, markdownPath } from './site';

/** Not pages, so never in markdown, llms.txt or the sitemap. Scripts and data stay crawlable: the app needs them to render. */
export const NOT_PAGES = ['/api/', '/data/', '/assets/'] as const;
/** Closed to crawlers: the API, except the markdown catalog and pages that llms.txt links to. */
const CRAWL_RULES = 'Allow: /\nAllow: /api/md/\nDisallow: /api/';
const SEARCH_BOTS = ['OAI-SearchBot', 'ChatGPT-User', 'Claude-SearchBot', 'Claude-User', 'PerplexityBot', 'Perplexity-User'];
const TRAINING_ALLOWED = ['GPTBot', 'ClaudeBot'];
const TRAINING_BLOCKED = ['Google-Extended', 'Applebot-Extended', 'CCBot', 'Bytespider'];
const LIMIT_CHARS = 500_000;

export function llmsTxt(): string {
  return [
    `# ${SITE.name}`,
    `> ${SITE.description}`,
    `${SITE.facts} Source code and contact: ${SITE.repository}.`,
    '<!-- Generated from the site config. Keep in sync with /robots.txt and /ai.txt. -->',
    '## Core pages',
    listMarkdownRoutes().map(route => `- [${route.title}](${absolute(route.markdown)}): ${route.summary}`).join('\n'),
    '## Machine-readable',
    [`- [Full content](${absolute('/llms-full.txt')}): every page above in one file`,
      `- [Markdown catalog](${absolute('/api/md/_catalog')}): JSON list of every markdown page`,
      `- [Sitemap](${absolute('/sitemap.xml')})`,
      `- [AI usage policy](${absolute('/ai.txt')})`].join('\n'),
    '## What we do not do',
    ['- Not a broker: no trading, orders, accounts or portfolio services.',
      '- No investment advice, tips or recommendations; scans and figures are research data.',
      '- No intraday or real-time quotes; every figure is end-of-day for a dated session.',
      '- Not affiliated with or endorsed by NSE, BSE or any index provider.'].join('\n'),
    '## Optional',
    `- [Source code and licence](${SITE.repository}): the app and data pipeline`,
  ].join('\n\n') + '\n';
}

export function llmsFullTxt(release: Release | null): string {
  const today = new Date().toISOString().slice(0, 10);
  const pages = MARKDOWN_ROUTES.map(route => `---\n<!-- source: ${absolute(route.path)} -->\n${route.render(release)}`);
  const text = [`# ${SITE.name} - full content`, `> ${SITE.description}`, `Generated: ${today}`, ...pages].join('\n\n');
  if (text.length > LIMIT_CHARS) console.warn(`llms-full.txt is ${text.length} characters, over the ${LIMIT_CHARS} budget`);
  return text;
}

export function aiTxt(): string {
  return [
    '# ai.txt - AI usage policy (ai-txt spec v1.1.1)',
    '# Keep in sync with /robots.txt and /llms.txt.',
    '',
    '[identity]',
    `name: ${SITE.name}`, `url: ${SITE.url}`, `description: ${SITE.description}`, `contact: ${SITE.contact}`,
    '',
    '[permissions]',
    'summarise: allowed', 'quote: allowed with attribution', 'cite: allowed', 'index-for-search: allowed', 'index-for-answers: allowed',
    `train: allowed for ${TRAINING_ALLOWED.join(', ')}; not allowed for other training crawlers`,
    '',
    '[restrictions]',
    'Do not fabricate quotes, figures, ratings or reviews attributed to this site.',
    'Do not present this content as your own; attribute it.',
    'Do not present screener results, scans or market data as investment advice or recommendations.',
    'Do not state figures without the trading session they belong to.',
    '',
    '[attribution]',
    `Cite as "${SITE.name}" with the canonical HTML URL of the page, e.g. ${absolute('/market')}.`,
    '',
    '[scope]',
    `include: ${MARKDOWN_ROUTES.map(route => route.path).join(', ')}, ${MARKDOWN_ROUTES.map(route => markdownPath(route.path)).join(', ')}`,
    `exclude: ${NOT_PAGES.join(', ')} (except /api/md/)`,
    '',
    '[contact]',
    `issues: ${SITE.contact}`,
    '',
    `Last updated: ${new Date().toISOString().slice(0, 10)}`,
  ].join('\n') + '\n';
}

export function robotsTxt(): string {
  const group = (agents: readonly string[], rules: string) => `${agents.map(agent => `User-agent: ${agent}`).join('\n')}\n${rules}`;
  return [
    `# ${SITE.name}`,
    `# Agents: ${absolute('/llms.txt')} describes the site; ${absolute('/ai.txt')} is the usage policy. Keep in sync with both.`,
    '# AI search and user-requested fetches: allowed on public pages.',
    group(SEARCH_BOTS, CRAWL_RULES),
    '# AI training crawlers allowed by the site owner.',
    group(TRAINING_ALLOWED, CRAWL_RULES),
    '# Other AI training crawlers: not allowed. This does not stop the search bots above from citing the site.',
    group(TRAINING_BLOCKED, 'Disallow: /'),
    group(['*'], CRAWL_RULES),
    `Sitemap: ${absolute('/sitemap.xml')}`,
  ].join('\n\n') + '\n';
}

/** HTML pages only; the `.md` alternates are noindex and stay out. */
export function sitemapXml(release: Release | null): string {
  const lastmod = release ? `<lastmod>${release.sessionDate}</lastmod>` : '';
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${
    MARKDOWN_ROUTES.map(route => `  <url><loc>${absolute(route.path)}</loc>${lastmod}</url>`).join('\n')}\n</urlset>\n`;
}

export const catalogJson = () => JSON.stringify({site: SITE.url, pages: listMarkdownRoutes().map(route => ({
  ...route, url: absolute(route.path), markdownUrl: absolute(route.markdown),
}))}, null, 2);
