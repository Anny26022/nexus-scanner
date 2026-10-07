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
import { mockAdapter } from './mockAdapter';

// Use real data by default. Set VITE_USE_MOCK=true to fall back to mock data.
const USE_MOCK_API = import.meta.env.VITE_USE_MOCK === 'true';
const adapter = USE_MOCK_API ? mockAdapter : realAdapter;

export const screenerApi = {
  async getChart(symbol: string, revision?: string): Promise<ChartSnapshot> {
    if (USE_MOCK_API) throw new Error('Charts are unavailable in mock mode');
    return realAdapter.getChart(symbol, revision);
  },

  async getCatalog(): Promise<ConditionDef[]> {
    return adapter.getCatalog();
  },

  async explainScreen(req: ExplainRequest): Promise<ExplainResponse> {
    return adapter.explainScreen(req);
  },

  async runScreen(req: ScreenerRunRequest): Promise<ScreenerRunResponse> {
    return adapter.runScreen(req);
  },

  async getIpos(): Promise<IPORow[]> {
    return adapter.getIpos();
  },

  async getIpoCatalogue(): Promise<IpoCatalogue> {
    return USE_MOCK_API ? {records: await mockAdapter.getIpos()} : realAdapter.getIpoCatalogue();
  },

  async compareSymbols(req: SymbolComparisonRequest): Promise<SymbolComparisonResponse> {
    return adapter.compareSymbols(req);
  },

  async getCurrentRevision(): Promise<RevisionCurrentResponse> {
    return adapter.getCurrentRevision();
  },
};
