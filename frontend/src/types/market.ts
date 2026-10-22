/** Market overview published with each scanner release (see frontend/market_overview.py). */
export interface BreadthSession {
  date: string;
  advances: number | null;
  declines: number | null;
  unchanged: number | null;
  up_4: number | null;
  down_4: number | null;
  above_10_pct: number | null;
  above_20_pct: number | null;
  above_50_pct: number | null;
  above_200_pct: number | null;
  new_52w_high: number | null;
  new_52w_low: number | null;
  nnh_52w: number | null;
  net_breadth: number | null;
  index_change_pct: number | null;
}

export interface SectorBreadth {
  name: string;
  stock_count: number | null;
  above_sma20_percent: number | null;
  above_sma50_percent: number | null;
  above_sma200_percent: number | null;
  near_52w_high_5_percent: number | null;
}

export interface IndexCard {
  symbol: string;
  name: string;
  date: string;
  close: number;
  changePct: number | null;
  series: number[];
}

export interface MarketOverview {
  schemaVersion: 1;
  asOfDate: string;
  breadth: BreadthSession[];
  sectors: SectorBreadth[];
  indices: IndexCard[];
}
