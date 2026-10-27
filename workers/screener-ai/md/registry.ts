import { SECTIONS, sectionTitle, type AppTab, type Section } from '../../../frontend/src/data/sections';
import { link, list, number, renderPage, signed, table, type Page } from './format';
import { SITE, markdownPath } from './site';

/** Headline facts from the latest published release, read from the same files the app loads. */
export interface Release {
  sessionDate: string;
  totalStocks: number;
  breadth?: {advances: number; declines: number; unchanged: number; new_52w_high: number; new_52w_low: number; above_50_pct: number; above_200_pct: number};
  indices?: {name: string; close: number; changePct: number}[];
  recentListings?: number;
}

type Assets = { fetch(request: Request): Promise<Response> };

async function readJson(assets: Assets, origin: string, path: string): Promise<unknown> {
  const response = await assets.fetch(new Request(new URL(path, origin)));
  if (!response.ok) throw new Error(`${path}: ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  // Revision files are stored gzipped; the asset server may or may not have decoded them already.
  const plain = bytes[0] === 0x1f && bytes[1] === 0x8b
    ? new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer())
    : bytes;
  return JSON.parse(new TextDecoder().decode(plain));
}

const DAY = 86_400_000;

/** The latest release, or null when it cannot be read: pages then describe the section without numbers. */
export async function loadRelease(assets: Assets, origin: string): Promise<Release | null> {
  try {
    const manifest = await readJson(assets, origin, '/data/current.json') as {sessionDate: string; totalStocks: number; marketOverviewUrl?: string};
    const release: Release = {sessionDate: manifest.sessionDate, totalStocks: manifest.totalStocks};
    const [overview, ipos] = await Promise.all([
      manifest.marketOverviewUrl ? readJson(assets, origin, manifest.marketOverviewUrl).catch(() => null) : null,
      readJson(assets, origin, '/data/ipos.json').catch(() => null),
    ]);
    const market = overview as {breadth?: Release['breadth'][]; indices?: Release['indices']} | null;
    release.breadth = market?.breadth?.at(-1) ?? undefined;
    release.indices = market?.indices?.map(({name, close, changePct}) => ({name, close, changePct}));
    if (Array.isArray(ipos)) {
      const since = Date.parse(`${manifest.sessionDate}T00:00:00Z`) - 90 * DAY;
      release.recentListings = ipos.filter(row => typeof row?.listing_date === 'string' && Date.parse(row.listing_date) >= since).length;
    }
    return release;
  } catch {
    return null;
  }
}

/** What each section offers, in the app's own terms. Facts only; numbers come from the release. */
const DETAILS: Record<AppTab, (release: Release | null) => string> = {
  screener: release => [
    '## What you can do',
    list([
      'Filter NSE mainboard equities, Nifty 50, Nifty 500 and MidSmall 400 universes, or ETFs.',
      'Combine technical, momentum, volume, relative-strength, fundamental and liquidity filters with AND or OR.',
      'Pick scans from the scan library (gainers, breakouts, bases, pullbacks, volume, earnings and more).',
      'Type a query such as `P/E < 20 AND EPS > 10`, or describe a screen in words with Ask AI.',
      'Save screens, share them as links, and backtest how often a screen matched over past sessions.',
    ]),
    release ? `## Latest session\n${table(['Session', 'Stocks screened'], [[release.sessionDate, number(release.totalStocks)]])}` : '',
  ].join('\n\n'),
  market: release => [
    '## What it shows',
    list(['Index moves for the Nifty family and Sensex.', 'Advance–decline breadth and the share of stocks above key moving averages.',
      'New 52-week highs and lows.', 'Which sectors, industries and themes money is moving into.']),
    release?.breadth ? `## Breadth on ${release.sessionDate}\n${table(['Advances', 'Declines', 'Unchanged', 'New 52-week highs', 'New 52-week lows', 'Above 50-day MA', 'Above 200-day MA'], [[
      number(release.breadth.advances), number(release.breadth.declines), number(release.breadth.unchanged),
      number(release.breadth.new_52w_high), number(release.breadth.new_52w_low),
      `${release.breadth.above_50_pct.toFixed(1)}%`, `${release.breadth.above_200_pct.toFixed(1)}%`]])}` : '',
    release?.indices?.length ? `## Indexes on ${release.sessionDate}\n${table(['Index', 'Close', 'Change'],
      release.indices.map(index => [index.name, number(index.close, 2), signed(index.changePct)]))}` : '',
  ].join('\n\n'),
  earnings: () => ['## What it shows', list([
    'Each quarter’s reported results: sales, operating profit, net profit and EPS growth, year on year and quarter on quarter.',
    'Results graded by quality and grouped by sector, industry or theme.',
    'The upcoming results calendar.',
    'How each stock traded into and after its result: the run-up, the first-day reaction and the move since.',
  ])].join('\n\n'),
  rotation: () => ['## What it shows', list([
    'Relative Rotation Graphs (RS-Ratio against RS-Momentum) for sectors, industries, sub-industries, themes and individual stocks.',
    'Benchmarks: Nifty 50, 100, 500, Midcap 150, Smallcap 250, MidSmallCap 400, Total Market, or an equal-weighted market.',
    'Daily, weekly and monthly timeframes, with replay to any past date in the history.',
  ])].join('\n\n'),
  ipo: release => [
    '## What it shows',
    list(['Newly listed NSE companies with listing date, last price, turnover, market cap and delivery.',
      'Offer details where published: issue price, subscription and listing performance.',
      'The screener’s filters and scans, run on new listings only.']),
    release?.recentListings != null ? `## Latest session\n${table(['Session', 'Listings in the last 90 days'], [[release.sessionDate, number(release.recentListings)]])}` : '',
  ].join('\n\n'),
  charts: () => ['## What it shows', list([
    'Daily, weekly and monthly candles for NSE stocks, with volume.',
    'Indicators including moving averages, relative strength and fundamentals overlays.',
    'Drawing tools (trend lines, channels, Fibonacci and more), saved per symbol.',
    'Layouts of up to 16 linked charts, saved workspaces and watchlists.',
  ])].join('\n\n'),
};

const sectionPage = (section: Section, release: Release | null): Page => ({
  title: sectionTitle(section), summary: section.summary, path: section.path, updated: release?.sessionDate,
  body: DETAILS[section.tab](release),
  related: [['Home', '/'], ...SECTIONS.filter(other => other !== section).map(other => [other.title, other.path] as [string, string])],
});

const homePage = (release: Release | null): Page => ({
  title: SITE.name, summary: SITE.description, path: '/', updated: release?.sessionDate,
  body: [SITE.facts, '## Sections', list(SECTIONS.map(section => `${link(section.title, section.path)} - ${section.summary}`)),
    release ? `## Latest release\nSession ${release.sessionDate}, ${number(release.totalStocks)} NSE stocks.` : ''].join('\n\n'),
  related: [['Source code', SITE.repository]],
});

export interface MarkdownRoute { path: string; title: string; summary: string; render: (release: Release | null) => string }

/** Every addressable markdown route. Register a page here and llms.txt, llms-full.txt and the catalog list it. */
export const MARKDOWN_ROUTES: readonly MarkdownRoute[] = [
  {path: '/', title: 'Home', summary: SITE.description, render: release => renderPage(homePage(release))},
  ...SECTIONS.map(section => ({path: section.path, title: section.title, summary: section.summary,
    render: (release: Release | null) => renderPage(sectionPage(section, release))})),
];

export const listMarkdownRoutes = () => MARKDOWN_ROUTES.map(({path, title, summary}) => ({path, markdown: markdownPath(path), title, summary}));

/** The route an HTML path or its `.md` form names, or null. */
export function routeFor(pathname: string): MarkdownRoute | null {
  const path = pathname === '/index.md' ? '/' : pathname.replace(/\.md$/, '').replace(/\/+$/, '') || '/';
  return MARKDOWN_ROUTES.find(route => route.path === path) ?? null;
}

export const notFoundMarkdown = (path: string) => renderPage({
  title: 'Page not found', summary: `There is no page at ${path}.`, path: '/',
  body: `## Pages on this site\n${list(listMarkdownRoutes().map(route => link(route.title, route.markdown)))}`,
});
