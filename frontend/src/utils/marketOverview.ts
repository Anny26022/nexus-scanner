import type { BreadthSession, IndexCard, MarketOverview, SectorBreadth } from '../types/market';

const BREADTH_FIELDS = [
  'advances', 'declines', 'unchanged', 'up_4', 'down_4', 'above_10_pct', 'above_20_pct', 'above_50_pct', 'above_200_pct',
  'new_52w_high', 'new_52w_low', 'nnh_52w', 'net_breadth', 'index_change_pct',
] as const;
const SECTOR_FIELDS = ['stock_count', 'above_sma20_percent', 'above_sma50_percent', 'above_sma200_percent', 'near_52w_high_5_percent'] as const;

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const finite = (value: unknown) => typeof value === 'number' && Number.isFinite(value);
const optionalNumber = (value: unknown) => value === null || finite(value);
const isDate = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);

/** Validates the published payload so the page never renders a malformed release. */
export function parseMarketOverview(value: unknown, sessionDate: string): MarketOverview {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.asOfDate !== sessionDate
      || !Array.isArray(value.breadth) || !Array.isArray(value.sectors) || !Array.isArray(value.indices)) {
    throw new Error('Market overview release mismatch');
  }
  const breadth = value.breadth.filter((row): row is BreadthSession => isRecord(row) && isDate(row.date) && row.date <= sessionDate
    && BREADTH_FIELDS.every(field => optionalNumber(row[field])));
  const sectors = value.sectors.filter((row): row is SectorBreadth => isRecord(row) && typeof row.name === 'string' && row.name.length > 0
    && SECTOR_FIELDS.every(field => optionalNumber(row[field])));
  const indices = value.indices.filter((row): row is IndexCard => isRecord(row) && typeof row.symbol === 'string'
    && typeof row.name === 'string' && isDate(row.date) && finite(row.close) && optionalNumber(row.changePct)
    && Array.isArray(row.series) && row.series.every(finite));
  if (!breadth.length) throw new Error('Market overview has no breadth data');
  return {schemaVersion: 1, asOfDate: sessionDate, breadth, sectors, indices};
}

/** Simple market regime label from the share of stocks above their 50- and 200-day averages. */
export function marketRegime(latest: BreadthSession): {label: string; tone: 'positive' | 'negative' | 'neutral'} {
  const above50 = latest.above_50_pct ?? 0;
  const above200 = latest.above_200_pct ?? 0;
  if (above50 >= 60 && above200 >= 55) return {label: 'Broad strength', tone: 'positive'};
  if (above50 <= 25 && above200 <= 40) return {label: 'Broad weakness', tone: 'negative'};
  if (above50 > above200) return {label: 'Improving', tone: 'positive'};
  return {label: 'Mixed', tone: 'neutral'};
}
