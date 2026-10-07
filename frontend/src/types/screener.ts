export type UniverseType = 'mainboard' | 'nifty50' | 'nifty500' | 'midsmall400' | 'custom';

export type MatchMode = 'all' | 'any';

export type ConditionCategory =
  | 'trend'
  | 'momentum'
  | 'range'
  | 'relative_strength'
  | 'fundamentals'
  | 'liquidity';

export type ParameterType = 'number' | 'select' | 'multiselect' | 'range' | 'boolean' | 'string';

export interface ParameterSpec {
  id: string;
  label: string;
  type: ParameterType;
  defaultValue: any;
  options?: Array<{ label: string; value: any }>;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  description?: string;
}

export interface ConditionDef {
  id: string;
  label: string;
  category: ConditionCategory;
  description: string;
  parameters: ParameterSpec[];
  requiresHistoricalData?: string[];
  supportedInAsOfDate?: boolean;
}

export interface ActiveCondition {
  instanceId: string;
  conditionId: string;
  parameters: Record<string, any>;
  isNegated?: boolean;
}

export interface ExpressionGroupNode {
  type: 'group';
  operator: MatchMode; // 'all' (AND) or 'any' (OR)
  children: ExpressionNode[];
}

export interface ExpressionConditionNode {
  type: 'condition';
  condition: ActiveCondition;
}

export type ExpressionNode = ExpressionGroupNode | ExpressionConditionNode;

export interface ScreenerRunRequest {
  announcementFilter?: import("../api/announcements").AnnouncementFilter;
  announcementSymbols?: string[];
  datasetRevision?: string;
  expressionTree: ExpressionNode;
  textQuery?: string;
  universe: UniverseType;
  customSymbols?: string[];
  asOfDate: string;
  quickFilters?: Record<string, any>;
  sort?: { field: string; direction: 'asc' | 'desc' };
  page: number;
  pageSize: number;
}

export interface StockRow {
  symbol: string;
  name: string;
  listingDate: string;
  sector: string; // "Unclassified" if missing
  industry: string; // "Unclassified" if missing
  series: string;
  close: number;
  changePct: number;
  open: number;
  high: number;
  low: number;
  volume: number;
  rupeeVolumeCrore: number;
  rvol: number | null;
  marketCapCrore: number;
  peRatio: number | null;
  epsTtm?: number | null;
  dividendYieldPct?: number | null;
  rsi14: number | null;
  adr20Pct: number | null;
  atr14: number | null;
  sma20: number | null;
  sma50: number | null;
  sma200: number | null;
  ema20: number | null;
  ema50: number | null;
  ema200: number | null;
  dist52wHighPct: number | null;
  dist52wLowPct: number | null;
  distAthPct: number | null;
  earningsDate: string | null;
  daysSinceEarnings: number | null;
  fnoBan: boolean;
  isFno: boolean;
  circuitLimit: string;
  deliveryPct: number | null;
  roePct?: number | null;
  rocePct?: number | null;
  opmTtmPct?: number | null;
  debtToEquity?: number | null;
  totalRevenueLakh?: number | null;
  nonCurrentAssetsLakh?: number | null;
  totalLiabilitiesLakh?: number | null;
  interestCoverage?: number | null;
  dividendPerShare?: number | null;
  vwap?: number | null;
  vwapAsOfDate?: string | null;
  allTimeHigh?: number | null;
  allTimeLow?: number | null;
  return5yPct?: number | null;
  historyMetadata?: Record<string, unknown> | null;
  financialMetadata?: Record<string, unknown> | null;
  dividendExDate?: string | null;

  pegRatio?: number | null;
  salesGrowth5yPct?: number | null;
  epsLastYear?: number | null;
  epsTwoYearsBack?: number | null;
  surveillanceAvailable?: boolean | null;
  surveillanceAsOfDate?: string | null;
  surveillanceFetchedAt?: string | null;
  isAsm?: boolean | null;
  asmStage?: string | null;
  isGsm?: boolean | null;
  gsmStage?: string | null;
  rsRating: number | null;
  dataCompleteness: number; // 0 to 100
}

export interface ScreenerRunResponse {
  resolvedSession: {
    date: string;
    sessionId: string;
    status: 'closed' | 'open';
    isHistorical: boolean;
  };
  immutableRevision: string;
  rows: StockRow[];
  matchCount: number;
  totalUniverseCount: number;
  page: number;
  pageSize: number;
  perConditionCoverage: Record<
    string,
    {
      conditionId: string;
      evaluated: number;
      matched: number;
      coveragePct: number;
    }
  >;
  unavailableDiagnostics: Array<{
    conditionId: string;
    reason: string;
    affectedCount: number;
  }>;
  warnings: string[];
}

export interface IPORow {
  symbol: string;
  name: string;
  listingDate: string;
  currentPrice: number;
  turnoverCrore: number;
  deliveryPct?: number | null;
  sector: string;
  industry: string;
  marketCapCrore: number;
  // Retained for the mock fixture; the live catalogue does not publish IPO terms.
  issuePrice?: number | null;
  listingPrice?: number | null;
  returnSinceListingPct?: number | null;
  circuitBand?: string;
  dataCompleteness?: number;
}

export interface ExplainRequest {
  expressionTree?: ExpressionNode;
  textQuery?: string;
  asOfDate: string;
}

export interface ExplainResponse {
  isValid: boolean;
  errors: string[];
  compiledExplanations: Array<{
    conditionId: string;
    humanReadableText: string;
    isDataAvailableForSession: boolean;
    unavailableReason?: string;
  }>;
  warnings: string[];
}

export interface SymbolComparisonRequest {
  symbols: string[];
}

export interface SymbolComparisonItem {
  symbol: string;
  name: string;
  sector: string;
  close: number;
  changePct: number;
  marketCapCrore: number;
  peRatio: number | null;
  rvol: number;
  rsi14: number | null;
  rsRating: number | null;
  sma50Status: string;
  isFno: boolean;
  isValid: boolean;
}

export interface SymbolComparisonResponse {
  validSymbols: SymbolComparisonItem[];
  invalidSymbols: string[];
  sessionDate: string;
  immutableRevision: string;
}

export interface RevisionCurrentResponse {
  latestSessionDate: string;
  availableSessions: Array<{ date: string; label: string; isHistorical: boolean }>;
  immutableRevision: string;
  mainboardUniverseCount: number;
  catalogVersion: string;
}
