/**
 * The app's public sections: one URL each. Shared by the app (tab ↔ address bar) and the Worker, which serves the
 * same sections as markdown, llms.txt and the sitemap. Adding a section here makes it reachable everywhere.
 */
export const SITE_NAME = 'Nexus Research Screener';
export type AppTab = 'screener' | 'market' | 'earnings' | 'rotation' | 'ipo' | 'charts';

export interface Section {
  tab: AppTab;
  path: `/${string}`;
  title: string;
  /** One or two factual sentences: the meta description, `ai-summary` and llms.txt line. */
  summary: string;
}

export const SECTIONS: readonly Section[] = [
  {tab: 'screener', path: '/screener', title: 'Screener',
    summary: 'Screen NSE mainboard equities and ETFs with technical, fundamental and liquidity filters and a library of pre-built scans, evaluated on one published trading session at a time.'},
  {tab: 'market', path: '/market', title: 'Market overview',
    summary: 'Daily NSE market overview: index moves, advance–decline breadth, new 52-week highs and lows, and how sectors and themes are trading.'},
  {tab: 'earnings', path: '/earnings', title: 'Earnings',
    summary: 'Quarterly results for NSE companies: sales, profit and EPS growth, beats and misses, the reporting calendar, and how each stock traded around its result.'},
  {tab: 'rotation', path: '/rotation', title: 'Rotation',
    summary: 'Relative Rotation Graphs for sectors, industries, themes and stocks against Nifty benchmarks, on daily, weekly and monthly timeframes.'},
  {tab: 'ipo', path: '/ipo', title: 'IPO Catalogue',
    summary: 'Recently listed NSE companies with listing date, issue price and performance since listing, with screening of new listings.'},
  {tab: 'charts', path: '/charts', title: 'Charts',
    summary: 'Daily, weekly and monthly price charts for NSE stocks with indicators, drawing tools, multi-chart layouts and watchlists.'},
];

export const sectionForTab = (tab: AppTab): Section => SECTIONS.find(section => section.tab === tab)!;
/** The browser title for a section; the Worker serves the same title in the page's HTML. */
export const sectionTitle = (section: Section) => `${section.title} | ${SITE_NAME}`;

/** The section a path names, ignoring a trailing slash; null for `/` and anything else. */
export function sectionForPath(pathname: string): Section | null {
  const path = pathname.replace(/\/+$/, '') || '/';
  return SECTIONS.find(section => section.path === path) ?? null;
}
