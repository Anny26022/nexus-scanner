export type RrgQuadrant = 'Leading' | 'Weakening' | 'Lagging' | 'Improving';

export interface RrgTrailPoint {
  week: number;
  date: string;
  x: number;
  y: number;
  quadrant: RrgQuadrant;
}

export interface RrgMetrics {
  excessReturn1m: number;
  excessReturn3m: number;
  excessReturn6m: number | null;
  medianRs: number;
  rsMomentum21d: number;
  beatingBenchmarkPct: number;
  improvingRsPct: number;
  setupCoveragePct: number;
  totalTurnover20Cr: number;
  concentrationTop3Pct: number;
  constituentCount: number;
  topContributors: string[];
}

export interface RrgConstituentStock {
  symbol: string;
  name: string;
  close: number;
  changePct: number;
  marketCapCr: number;
  rsRating: number | null;
  rsChange21d: number | null;
  return1m: number | null;
  return3m: number | null;
  return6m: number | null;
  excessReturn3m: number | null;
  turnover20Cr: number;
  setups: {
    stage2: boolean;
    vcp: boolean;
    darvas: boolean;
    bullFlag: boolean;
    cupHandle: boolean;
    pocketPivot: boolean;
    coiled: boolean;
    tightWeeks: boolean;
  };
  trendScore: number;
  status: 'strengthening' | 'weakening';
}

export interface RrgBlockItem {
  name: string;
  parentBlock: null;
  macro: string | null;
  quadrant: RrgQuadrant;
  x: number;
  y: number;
  trail: RrgTrailPoint[];
  metrics: RrgMetrics;
  constituents: RrgConstituentStock[];
  niches: string[];
  nicheCount: number;
}

export interface RrgNicheItem {
  name: string;
  parentBlock: string | null;
  macro: string | null;
  quadrant: RrgQuadrant;
  x: number;
  y: number;
  trail: RrgTrailPoint[];
  metrics: RrgMetrics;
  constituents: RrgConstituentStock[];
}

export interface RrgThematicIndexItem extends RrgNicheItem {
  indexSymbol: string;
}

export interface RrgIpoItem {
  symbol: string;
  name: string;
  listingDate: string;
  listingAgeDays: number;
  sessions: number;
  marketCapCr: number;
  close: number;
  changePct: number;
  excessReturn10d: number;
  turnoverIntensity: number;
  turnoverCr: number;
  deliveryPct: number | null;
  gainSinceListingPct: number;
  quadrant: RrgQuadrant;
  x: number;
  y: number;
  trail: RrgTrailPoint[];
  theme: string | null;
  block: string | null;
}

export interface ThematicRrgResponse {
  schemaVersion: number;
  rsMethodologyVersion?: string;
  rsCoverage?: {requestedDates: string[]; availableDates: string[]; momentumAvailable?: boolean};
  asOfDate: string;
  generatedAt: string;
  benchmark: string;
  benchmark3mReturn: number;
  trailWeeks: number;
  totalBlocks: number;
  totalNiches: number;
  totalThematicIndices?: number;
  thematicIndexMethodology?: string;
  thematicIndexCoverage?: {requested: number; available: number; missing: string[]};
  totalEquities: number;
  constituentEligibility?: {
    marketCapCrStrictlyGreaterThan: number;
    closeStrictlyGreaterThan: number;
    eligibleSymbols: number;
  };
  blocks: RrgBlockItem[];
  niches: RrgNicheItem[];
  thematicIndices?: RrgThematicIndexItem[];
  ipoTactical: RrgIpoItem[];
}
