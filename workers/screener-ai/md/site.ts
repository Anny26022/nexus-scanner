/** Who the site is: the one source for llms.txt, ai.txt, robots.txt, JSON-LD and every markdown page. */
import { SITE_NAME } from '../../../frontend/src/data/sections';

export const SITE = {
  name: SITE_NAME,
  url: 'https://nexus-scanner.aniketmahato26.workers.dev',
  description: 'Nexus Research Screener is a research tool for NSE (India) equities: a quantitative stock screener, '
    + 'a daily market-breadth overview, an earnings tracker, sector rotation graphs, an IPO catalogue and price charts.',
  facts: 'Every figure comes from one published end-of-day NSE trading session; releases are immutable and dated. '
    + 'The site is public with no sign-in. It is for research and education, not investment advice, and market data '
    + 'can be delayed, incomplete or corrected upstream.',
  repository: 'https://github.com/Anny26022/nexus-scanner',
  contact: 'https://github.com/Anny26022/nexus-scanner/issues',
  logo: '/favicon.svg',
} as const;

/** The canonical HTML URL for a path on the site. */
export const absolute = (path: string) => `${SITE.url}${path.startsWith('/') ? path : `/${path}`}`;

/** The markdown alternate of an HTML path: `/` → `/index.md`, `/market` → `/market.md`. */
export const markdownPath = (path: string) => path === '/' ? '/index.md' : `${path.replace(/\/+$/, '')}.md`;
