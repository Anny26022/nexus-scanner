import {
  ScreenerRunRequest,
  ScreenerRunResponse,
  ExplainRequest,
  ExplainResponse,
  IPORow,
  IpoCatalogue,
  SymbolComparisonRequest,
  SymbolComparisonResponse,
  RevisionCurrentResponse,
  ConditionDef,
} from '../types/screener';
import { realAdapter, type ChartSnapshot } from './realAdapter';

// Use real data by default. Set VITE_USE_MOCK=true to fall back to mock data.
const USE_MOCK_API = import.meta.env.VITE_USE_MOCK === 'true';
let mock: Promise<typeof import('./mockAdapter')['mockAdapter']> | undefined;
const getAdapter = () => USE_MOCK_API
  ? mock ??= import('./mockAdapter').then(module => module.mockAdapter).catch(error => {mock = undefined; throw error;})
  : Promise.resolve(realAdapter);

export const screenerApi = {
  getChartRows: realAdapter.getChartRows.bind(realAdapter),
  getFinancialHistory: realAdapter.getFinancialHistory.bind(realAdapter),
  getEarningsSchedule: realAdapter.getEarningsSchedule.bind(realAdapter),
  getPriceBandHistory: (symbol: string, revision: string) => realAdapter.getPriceBandHistory(symbol, revision),
  getThemeClassification: realAdapter.getThemeClassification.bind(realAdapter),
  async getExportRows(request: ScreenerRunRequest) {
    const req = {...request, page:1, pageSize:100};
    const adapter = await getAdapter();
    const first = USE_MOCK_API ? await adapter.runScreen(req) : await realAdapter.runScreen(req, true);
    const rows = [...first.rows];
    // API-backed queries and mock screens retain pagination; snapshot screens
    // return their cached full match set in one worker operation.
    for (let page = 2; rows.length < first.matchCount; page++) {
      const next = await adapter.runScreen({...req, page, datasetRevision:first.immutableRevision});
      if (next.immutableRevision !== first.immutableRevision || next.matchCount !== first.matchCount || !next.rows.length) {
        throw new Error('Results changed during export. Run the scan again.');
      }
      rows.push(...next.rows);
    }
    if (rows.length !== first.matchCount || new Set(rows.map(row=>row.symbol)).size !== first.matchCount) {
      throw new Error('Incomplete export results. Run the scan again.');
    }
    return rows;
  },
  getMarketOverview: (revision?: string) => realAdapter.getMarketOverview(revision),
  getBenchmark: (revision?: string) => realAdapter.getBenchmark(revision),
  getFilterChoices: realAdapter.getFilterChoices.bind(realAdapter),
  getAnnouncementIndex: realAdapter.getAnnouncementIndex.bind(realAdapter),
  getAnnouncementTopics: realAdapter.getAnnouncementTopics.bind(realAdapter),
  getAnnouncements: realAdapter.getAnnouncements.bind(realAdapter),
  getAnnouncementHistory: realAdapter.getAnnouncementHistory.bind(realAdapter),
  getAnnouncementDetail: realAdapter.getAnnouncementDetail.bind(realAdapter),
  async getChart(symbol: string, revision?: string, sessionDate?: string): Promise<ChartSnapshot> {
    if (USE_MOCK_API) throw new Error('Charts are unavailable in mock mode');
    return realAdapter.getChart(symbol, revision, sessionDate);
  },

  async getCatalog(): Promise<ConditionDef[]> {
    return (await getAdapter()).getCatalog();
  },

  async explainScreen(req: ExplainRequest): Promise<ExplainResponse> {
    return (await getAdapter()).explainScreen(req);
  },

  async runScreen(req: ScreenerRunRequest): Promise<ScreenerRunResponse> {
    if (USE_MOCK_API && req.announcementFilter) throw new Error('Announcement filters are unavailable in mock mode');
    return (await getAdapter()).runScreen(req);
  },

  async getIpos(): Promise<IPORow[]> {
    return (await getAdapter()).getIpos();
  },

  async getIpoCatalogue(): Promise<IpoCatalogue> {
    return USE_MOCK_API ? {records: await (await getAdapter()).getIpos()} : realAdapter.getIpoCatalogue();
  },

  async compareSymbols(req: SymbolComparisonRequest): Promise<SymbolComparisonResponse> {
    return (await getAdapter()).compareSymbols(req);
  },

  async getCurrentRevision(): Promise<RevisionCurrentResponse> {
    return (await getAdapter()).getCurrentRevision();
  },

  async getAvailableSessions(): Promise<Array<{ date: string; label: string; isHistorical: boolean; revision: string }>> {
    return USE_MOCK_API ? [] : realAdapter.getAvailableSessions();
  },
};
