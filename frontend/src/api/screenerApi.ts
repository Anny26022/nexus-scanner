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
  getAnnouncementIndex: realAdapter.getAnnouncementIndex.bind(realAdapter),
  getAnnouncementTopics: realAdapter.getAnnouncementTopics.bind(realAdapter),
  getAnnouncements: realAdapter.getAnnouncements.bind(realAdapter),
  getAnnouncementHistory: realAdapter.getAnnouncementHistory.bind(realAdapter),
  getAnnouncementDetail: realAdapter.getAnnouncementDetail.bind(realAdapter),
  async getChart(symbol: string, revision?: string): Promise<ChartSnapshot> {
    if (USE_MOCK_API) throw new Error('Charts are unavailable in mock mode');
    return realAdapter.getChart(symbol, revision);
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
};
