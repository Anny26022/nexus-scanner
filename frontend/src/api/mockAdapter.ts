import {
  StockRow,
  IPORow,
  ScreenerRunRequest,
  ScreenerRunResponse,
  ExplainRequest,
  ExplainResponse,
  SymbolComparisonRequest,
  SymbolComparisonResponse,
  RevisionCurrentResponse,
  ConditionDef,
} from '../types/screener';
import { NEXUS_CONDITION_CATALOG } from '../data/conditionCatalog';
import { explainExpressionTree } from '../utils/nqlParser';

// Realistic mock dataset representing NSE mainboard stocks
const MOCK_NSE_MAINBOARD_STOCKS: StockRow[] = [
  {
    symbol: 'RELIANCE',
    name: 'Reliance Industries Limited',
    listingDate: '1995-11-29',
    sector: 'Energy & Petrochemicals',
    industry: 'Oil & Gas Refining',
    series: 'EQ',
    close: 2984.5,
    changePct: 2.45,
    open: 2920.0,
    high: 2995.0,
    low: 2915.0,
    volume: 8450200,
    rupeeVolumeCrore: 2521.8,
    rvol: 2.15,
    marketCapCrore: 2019250.0,
    peRatio: 28.4,
    rsi14: 64.2,
    adr20Pct: 2.15,
    atr14: 62.5,
    sma20: 2910.0,
    sma50: 2820.0,
    sma200: 2650.0,
    ema20: 2925.0,
    ema50: 2845.0,
    ema200: 2680.0,
    dist52wHighPct: -1.2,
    dist52wLowPct: 38.5,
    distAthPct: -1.2,
    earningsDate: '2026-07-19',
    daysSinceEarnings: 71,
    fnoBan: false,
    isFno: true,
    circuitLimit: '20%',
    deliveryPct: 58.4,
    rsRating: 88,
    dataCompleteness: 100,
  },
  {
    symbol: 'TCS',
    name: 'Tata Consultancy Services Limited',
    listingDate: '2004-08-25',
    sector: 'Information Technology',
    industry: 'IT Services & Consulting',
    series: 'EQ',
    close: 4215.0,
    changePct: 1.15,
    open: 4180.0,
    high: 4235.0,
    low: 4170.0,
    volume: 2410500,
    rupeeVolumeCrore: 1015.8,
    rvol: 1.45,
    marketCapCrore: 1524800.0,
    peRatio: 31.8,
    rsi14: 58.4,
    adr20Pct: 1.85,
    atr14: 76.0,
    sma20: 4150.0,
    sma50: 4020.0,
    sma200: 3850.0,
    ema20: 4170.0,
    ema50: 4060.0,
    ema200: 3890.0,
    dist52wHighPct: -3.5,
    dist52wLowPct: 29.1,
    distAthPct: -3.5,
    earningsDate: '2026-07-11',
    daysSinceEarnings: 79,
    fnoBan: false,
    isFno: true,
    circuitLimit: '20%',
    deliveryPct: 62.1,
    rsRating: 82,
    dataCompleteness: 100,
  },
  {
    symbol: 'HDFCBANK',
    name: 'HDFC Bank Limited',
    listingDate: '1995-11-08',
    sector: 'Financial Services',
    industry: 'Private Sector Bank',
    series: 'EQ',
    close: 1642.8,
    changePct: -0.45,
    open: 1655.0,
    high: 1660.0,
    low: 1638.0,
    volume: 12450000,
    rupeeVolumeCrore: 2045.2,
    rvol: 1.10,
    marketCapCrore: 1251400.0,
    peRatio: 19.2,
    rsi14: 49.5,
    adr20Pct: 1.65,
    atr14: 26.4,
    sma20: 1650.0,
    sma50: 1610.0,
    sma200: 1540.0,
    ema20: 1648.0,
    ema50: 1622.0,
    ema200: 1560.0,
    dist52wHighPct: -7.8,
    dist52wLowPct: 19.4,
    distAthPct: -7.8,
    earningsDate: '2026-07-20',
    daysSinceEarnings: 70,
    fnoBan: false,
    isFno: true,
    circuitLimit: '20%',
    deliveryPct: 68.5,
    rsRating: 65,
    dataCompleteness: 100,
  },
  {
    symbol: 'BHARTIARTL',
    name: 'Bharti Airtel Limited',
    listingDate: '2002-02-15',
    sector: 'Telecommunication',
    industry: 'Telecom - Cellular & Fixed Line',
    series: 'EQ',
    close: 1598.0,
    changePct: 3.85,
    open: 1545.0,
    high: 1608.0,
    low: 1540.0,
    volume: 9850100,
    rupeeVolumeCrore: 1574.0,
    rvol: 2.85,
    marketCapCrore: 962500.0,
    peRatio: 64.5,
    rsi14: 73.8,
    adr20Pct: 2.65,
    atr14: 41.2,
    sma20: 1520.0,
    sma50: 1440.0,
    sma200: 1280.0,
    ema20: 1538.0,
    ema50: 1460.0,
    ema200: 1310.0,
    dist52wHighPct: 0.0,
    dist52wLowPct: 68.4,
    distAthPct: 0.0,
    earningsDate: '2026-08-05',
    daysSinceEarnings: 55,
    fnoBan: false,
    isFno: true,
    circuitLimit: '20%',
    deliveryPct: 54.2,
    rsRating: 96,
    dataCompleteness: 100,
  },
  {
    symbol: 'TRENT',
    name: 'Trent Limited',
    listingDate: '1998-11-20',
    sector: 'Consumer Services',
    industry: 'Retailing',
    series: 'EQ',
    close: 7420.0,
    changePct: 4.95,
    open: 7080.0,
    high: 7480.0,
    low: 7050.0,
    volume: 3850000,
    rupeeVolumeCrore: 2856.7,
    rvol: 3.42,
    marketCapCrore: 263700.0,
    peRatio: 145.2,
    rsi14: 78.5,
    adr20Pct: 3.85,
    atr14: 275.0,
    sma20: 6850.0,
    sma50: 6200.0,
    sma200: 4950.0,
    ema20: 6940.0,
    ema50: 6380.0,
    ema200: 5120.0,
    dist52wHighPct: 0.0,
    dist52wLowPct: 142.5,
    distAthPct: 0.0,
    earningsDate: '2026-08-08',
    daysSinceEarnings: 52,
    fnoBan: false,
    isFno: true,
    circuitLimit: '20%',
    deliveryPct: 46.8,
    rsRating: 99,
    dataCompleteness: 100,
  },
  {
    symbol: 'DIXON',
    name: 'Dixon Technologies (India) Limited',
    listingDate: '2017-09-28',
    sector: 'Capital Goods',
    industry: 'Consumer Electronics',
    series: 'EQ',
    close: 12850.0,
    changePct: 3.40,
    open: 12450.0,
    high: 12920.0,
    low: 12400.0,
    volume: 1120000,
    rupeeVolumeCrore: 1439.2,
    rvol: 2.65,
    marketCapCrore: 76890.0,
    peRatio: 112.4,
    rsi14: 71.4,
    adr20Pct: 3.25,
    atr14: 410.0,
    sma20: 12100.0,
    sma50: 11200.0,
    sma200: 8900.0,
    ema20: 12250.0,
    ema50: 11450.0,
    ema200: 9200.0,
    dist52wHighPct: -0.5,
    dist52wLowPct: 118.0,
    distAthPct: -0.5,
    earningsDate: '2026-07-29',
    daysSinceEarnings: 62,
    fnoBan: false,
    isFno: true,
    circuitLimit: '20%',
    deliveryPct: 41.5,
    rsRating: 97,
    dataCompleteness: 100,
  },
  {
    symbol: 'SUZLON',
    name: 'Suzlon Energy Limited',
    listingDate: '2005-10-19',
    sector: 'Capital Goods',
    industry: 'Heavy Electrical Equipment',
    series: 'EQ',
    close: 82.4,
    changePct: 4.97,
    open: 78.5,
    high: 82.4,
    low: 78.5,
    volume: 145000000,
    rupeeVolumeCrore: 1194.8,
    rvol: 1.85,
    marketCapCrore: 112400.0,
    peRatio: 88.5,
    rsi14: 76.2,
    adr20Pct: 4.85,
    atr14: 3.8,
    sma20: 74.5,
    sma50: 68.0,
    sma200: 52.0,
    ema20: 75.8,
    ema50: 69.5,
    ema200: 54.2,
    dist52wHighPct: 0.0,
    dist52wLowPct: 185.0,
    distAthPct: -72.0,
    earningsDate: '2026-07-25',
    daysSinceEarnings: 66,
    fnoBan: false,
    isFno: true,
    circuitLimit: '5%',
    deliveryPct: 38.2,
    rsRating: 94,
    dataCompleteness: 100,
  },
  {
    symbol: 'MAZDOCK',
    name: 'Mazagon Dock Shipbuilders Limited',
    listingDate: '2020-10-12',
    sector: 'Capital Goods',
    industry: 'Shipbuilding & Allied Services',
    series: 'EQ',
    close: 4850.0,
    changePct: 6.20,
    open: 4580.0,
    high: 4920.0,
    low: 4550.0,
    volume: 4850000,
    rupeeVolumeCrore: 2352.2,
    rvol: 3.85,
    marketCapCrore: 97800.0,
    peRatio: 48.2,
    rsi14: 75.1,
    adr20Pct: 4.45,
    atr14: 215.0,
    sma20: 4400.0,
    sma50: 4100.0,
    sma200: 3100.0,
    ema20: 4480.0,
    ema50: 4190.0,
    ema200: 3250.0,
    dist52wHighPct: -1.8,
    dist52wLowPct: 155.0,
    distAthPct: -1.8,
    earningsDate: '2026-08-10',
    daysSinceEarnings: 50,
    fnoBan: true,
    isFno: true,
    circuitLimit: '10%',
    deliveryPct: 34.0,
    rsRating: 98,
    dataCompleteness: 100,
  },
  {
    symbol: 'KAYNES',
    name: 'Kaynes Technology India Limited',
    listingDate: '2022-11-22',
    sector: 'Unclassified', // Intentionally Unclassified to test requirement 5
    industry: 'Unclassified',
    series: 'EQ',
    close: 5410.0,
    changePct: -1.85,
    open: 5520.0,
    high: 5550.0,
    low: 5380.0,
    volume: 680000,
    rupeeVolumeCrore: 367.8,
    rvol: 0.95,
    marketCapCrore: 34500.0,
    peRatio: 98.4,
    rsi14: 51.2,
    adr20Pct: 3.10,
    atr14: 165.0,
    sma20: 5480.0,
    sma50: 5200.0,
    sma200: 4100.0,
    ema20: 5460.0,
    ema50: 5280.0,
    ema200: 4250.0,
    dist52wHighPct: -8.5,
    dist52wLowPct: 82.0,
    distAthPct: -8.5,
    earningsDate: '2026-07-28',
    daysSinceEarnings: 63,
    fnoBan: false,
    isFno: false,
    circuitLimit: '20%',
    deliveryPct: 48.0,
    rsRating: 89,
    dataCompleteness: 90,
  },
];

// Mock IPO / New Listings Catalog
const MOCK_IPO_CATALOG: IPORow[] = [
  {
    symbol: 'BAJAJHFL',
    name: 'Bajaj Housing Finance Limited',
    listingDate: '2024-09-16',
    issuePrice: 70,
    listingPrice: 150,
    currentPrice: 168.5,
    returnSinceListingPct: 140.7,
    turnoverCrore: 1450.0,
    sector: 'Financial Services',
    industry: 'Housing Finance',
    marketCapCrore: 140500.0,
    circuitBand: '20%',
    dataCompleteness: 100,
  },
  {
    symbol: 'SWIGGY',
    name: 'Swiggy Limited',
    listingDate: '2024-11-13',
    issuePrice: 390,
    listingPrice: 420,
    currentPrice: 445.0,
    returnSinceListingPct: 14.1,
    turnoverCrore: 890.5,
    sector: 'Consumer Services',
    industry: 'Food Delivery & Quick Commerce',
    marketCapCrore: 99600.0,
    circuitBand: '20%',
    dataCompleteness: 100,
  },
  {
    symbol: 'HYUNDAI',
    name: 'Hyundai Motor India Limited',
    listingDate: '2024-10-22',
    issuePrice: 1960,
    listingPrice: 1934,
    currentPrice: 1845.0,
    returnSinceListingPct: -5.87,
    turnoverCrore: 620.0,
    sector: 'Automobile and Auto Components',
    industry: 'Passenger Cars',
    marketCapCrore: 150000.0,
    circuitBand: '20%',
    dataCompleteness: 100,
  },
  {
    symbol: 'NEXUSREIT',
    name: 'Nexus Select Trust REIT',
    listingDate: '2023-05-19',
    issuePrice: 100,
    listingPrice: 104,
    currentPrice: 138.2,
    returnSinceListingPct: 38.2,
    turnoverCrore: 45.0,
    sector: 'Real Estate',
    industry: 'Commercial REIT',
    marketCapCrore: 21000.0,
    circuitBand: '10%',
    dataCompleteness: 85,
  },
];

export class MockScreenerAdapter {
  async getCatalog(): Promise<ConditionDef[]> {
    await this.delay(100);
    return NEXUS_CONDITION_CATALOG;
  }

  async explainScreen(req: ExplainRequest): Promise<ExplainResponse> {
    await this.delay(150);
    if (req.expressionTree) {
      return explainExpressionTree(req.expressionTree, req.asOfDate);
    }
    return {
      isValid: true,
      errors: [],
      compiledExplanations: [],
      warnings: [],
    };
  }

  async runScreen(req: ScreenerRunRequest): Promise<ScreenerRunResponse> {
    await this.delay(300);

    let filtered = [...MOCK_NSE_MAINBOARD_STOCKS];

    // Filter by universe
    if (req.universe === 'nifty50') {
      filtered = filtered.filter((s) =>
        ['RELIANCE', 'TCS', 'HDFCBANK', 'BHARTIARTL'].includes(s.symbol)
      );
    } else if (req.universe === 'custom' && req.customSymbols?.length) {
      const set = new Set(req.customSymbols.map((sym) => sym.toUpperCase()));
      filtered = filtered.filter((s) => set.has(s.symbol));
    }

    // Evaluate basic condition tree filters
    if (req.expressionTree) {
      filtered = this.filterByTree(filtered, req.expressionTree);
    }

    // Sort rows
    if (req.sort) {
      const field = req.sort.field as keyof StockRow;
      const dir = req.sort.direction === 'asc' ? 1 : -1;
      filtered.sort((a, b) => {
        const valA = a[field] ?? 0;
        const valB = b[field] ?? 0;
        if (valA < valB) return -1 * dir;
        if (valA > valB) return 1 * dir;
        return 0;
      });
    }

    // Pagination
    const search = req.symbolSearch?.trim().toLowerCase();
    if (search) filtered = filtered.filter(row => row.symbol.toLowerCase().includes(search) || row.name.toLowerCase().includes(search));
    const totalCount = filtered.length;
    const startIndex = (req.page - 1) * req.pageSize;
    const paginatedRows = filtered.slice(startIndex, startIndex + req.pageSize);

    const isHistorical = req.asOfDate < '2026-09-28';
    const warnings: string[] = [];
    if (isHistorical) {
      warnings.push(`Screen executed against historical session as-of ${req.asOfDate}.`);
    }

    return {
      resolvedSession: {
        date: req.asOfDate || '2026-09-28',
        sessionId: `NSE-${req.asOfDate.replace(/-/g, '')}-FINAL`,
        status: 'closed',
        isHistorical,
      },
      immutableRevision: `rev_${req.asOfDate.replace(/-/g, '')}_c8f39a`,
      rows: paginatedRows,
      matchCount: totalCount,
      totalUniverseCount: MOCK_NSE_MAINBOARD_STOCKS.length,
      page: req.page,
      pageSize: req.pageSize,
      perConditionCoverage: {
        mom_rvol: {
          conditionId: 'mom_rvol',
          evaluated: MOCK_NSE_MAINBOARD_STOCKS.length,
          matched: filtered.length,
          coveragePct: 100.0,
        },
      },
      unavailableDiagnostics: isHistorical
        ? [
            {
              conditionId: 'mom_delivery_pct',
              reason: 'Historical NSE delivery breakdown not archived for legacy session.',
              affectedCount: MOCK_NSE_MAINBOARD_STOCKS.length,
            },
          ]
        : [],
      warnings,
    };
  }

  async getIpos(): Promise<IPORow[]> {
    await this.delay(200);
    return MOCK_IPO_CATALOG;
  }

  async compareSymbols(req: SymbolComparisonRequest): Promise<SymbolComparisonResponse> {
    await this.delay(250);
    const validSymbols: any[] = [];
    const invalidSymbols: string[] = [];

    req.symbols.forEach((sym: string) => {
      const clean = sym.trim().toUpperCase();
      const match = MOCK_NSE_MAINBOARD_STOCKS.find((s) => s.symbol === clean);
      if (match) {
        validSymbols.push({
          symbol: match.symbol,
          name: match.name,
          sector: match.sector,
          close: match.close,
          changePct: match.changePct,
          marketCapCrore: match.marketCapCrore,
          peRatio: match.peRatio,
          rvol: match.rvol,
          rsi14: match.rsi14,
          rsRating: match.rsRating,
          sma50Status: match.close > (match.sma50 || 0) ? 'Above SMA50' : 'Below SMA50',
          isFno: match.isFno,
          isValid: true,
        });
      } else {
        invalidSymbols.push(clean);
      }
    });

    return {
      validSymbols,
      invalidSymbols,
      sessionDate: '2026-09-28',
      immutableRevision: 'rev_20260928_c8f39a',
    };
  }

  async getCurrentRevision(): Promise<RevisionCurrentResponse> {
    await this.delay(100);
    return {
      latestSessionDate: '2026-09-28',
      availableSessions: [
        { date: '2026-09-28', label: '2026-09-28 (Latest Closed)', isHistorical: false },
        { date: '2026-09-27', label: '2026-09-27', isHistorical: true },
        { date: '2026-09-26', label: '2026-09-26', isHistorical: true },
        { date: '2026-09-25', label: '2026-09-25', isHistorical: true },
        { date: '2024-01-01', label: '2024-01-01 (Legacy Archive)', isHistorical: true },
      ],
      immutableRevision: 'rev_20260928_c8f39a',
      mainboardUniverseCount: 2240,
      catalogVersion: 'v3.2.0',
    };
  }

  private filterByTree(stocks: StockRow[], node: any): StockRow[] {
    if (node.type === 'group') {
      if (!node.children || node.children.length === 0) return stocks;
      const isAny = node.operator === 'any';
      return stocks.filter((stock) => {
        if (isAny) {
          return node.children.some((child: any) => this.evalNode(stock, child));
        } else {
          return node.children.every((child: any) => this.evalNode(stock, child));
        }
      });
    }
    return stocks.filter((stock) => this.evalNode(stock, node));
  }

  private evalNode(stock: StockRow, node: any): boolean {
    if (node.type === 'group') {
      const isAny = node.operator === 'any';
      if (isAny) {
        return node.children.some((c: any) => this.evalNode(stock, c));
      } else {
        return node.children.every((c: any) => this.evalNode(stock, c));
      }
    } else if (node.type === 'condition') {
      const c = node.condition;
      const p = c.parameters;
      switch (c.conditionId) {
        case 'mom_rvol':
          return stock.rvol != null && stock.rvol >= (p.minRvol ?? 0) && stock.rvol <= (p.maxRvol ?? 100);
        case 'trend_price_vs_ma':
          if (p.maPeriod === 50) return stock.close > (stock.sma50 ?? 0);
          if (p.maPeriod === 20) return stock.close > (stock.sma20 ?? 0);
          if (p.maPeriod === 200) return stock.close > (stock.sma200 ?? 0);
          return true;
        case 'mom_price_change':
          return stock.changePct >= (p.minChangePct ?? -100);
        case 'rs_rating_nexus':
          return (stock.rsRating ?? 0) >= (p.minRsRating ?? 0);
        case 'fund_fno_status':
          if (p.fnoFilter === 'fno_only') return stock.isFno;
          if (p.fnoFilter === 'in_fno_ban') return stock.fnoBan;
          if (p.fnoFilter === 'non_fno_only') return !stock.isFno;
          return true;
        default:
          return true;
      }
    }
    return true;
  }

  private delay(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export const mockAdapter = new MockScreenerAdapter();
