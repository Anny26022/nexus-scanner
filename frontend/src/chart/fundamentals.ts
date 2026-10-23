/** Statement amounts are INR crore; EPS is INR/share, margins are percent. */
export interface FinancialPeriod {
  period_end: string;
  filing_date?: string;
  [metric: string]: number | string | null | undefined;
}
export interface FinancialHistory {
  source: string;
  report_type: string;
  amount_unit: string;
  observed_on: string;
  quarterly: FinancialPeriod[];
  annual: FinancialPeriod[];
}
export interface FundamentalsConfig {
  enabled: boolean;
  layout?: 'compact' | 'results' | 'essential';
  period?: 'quarterly' | 'annual';
  profit?: 'eps' | 'net_profit';
  count?: number;
  position?: 'top-right' | 'bottom-right' | 'bottom-left';
  offset?: {x: number; y: number} | null;
  fontSize?: number;
  band?: boolean;
  guides?: boolean;
  earningsMarkers?: boolean;
}
export const fundamentalsDefaults: FundamentalsConfig = {
  enabled: false, layout: 'compact', period: 'quarterly', profit: 'eps', count: 4,
  position: 'top-right', offset: null, fontSize: 11, band: true, guides: false, earningsMarkers: true,
};
export function fundamentalsConfig(raw?: FundamentalsConfig): Required<FundamentalsConfig> {
  return {
    ...fundamentalsDefaults, ...raw, enabled: raw?.enabled === true,
    layout: ['compact', 'results', 'essential'].includes(raw?.layout ?? '') ? raw!.layout! : 'compact',
    period: raw?.period === 'annual' ? 'annual' : 'quarterly',
    profit: raw?.profit === 'net_profit' ? 'net_profit' : 'eps',
    count: Math.max(3, Math.min(13, Math.round(raw?.count ?? 4) || 4)),
    fontSize: Math.max(10, Math.min(15, Math.round(raw?.fontSize ?? 11) || 11)),
    position: ['top-right', 'bottom-right', 'bottom-left'].includes(raw?.position ?? '') ? raw!.position! : 'top-right',
    offset: raw?.offset && Number.isFinite(raw.offset.x) && Number.isFinite(raw.offset.y)
      ? {x: Math.max(0, Math.min(1, raw.offset.x)), y: Math.max(0, Math.min(1, raw.offset.y))} : null,
    band: raw?.band !== false, guides: raw?.guides === true, earningsMarkers: raw?.earningsMarkers !== false,
  } as Required<FundamentalsConfig>;
}
const date = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
export function visibleFinancials(history: FinancialHistory | null | undefined, period: 'quarterly' | 'annual', cutoff: string): FinancialPeriod[] {
  // An observation can contain revisions of older reports. Do not backdate those values.
  if (!history || history.amount_unit !== 'INR_CRORE' || !date(history.observed_on) || history.observed_on > cutoff) return [];
  if (!Array.isArray(history[period])) return [];
  return history[period].filter(row => row && date(row.period_end) && row.period_end <= cutoff
    && (!row.filing_date || (date(row.filing_date) && row.filing_date <= cutoff)))
    .sort((a, b) => b.period_end.localeCompare(a.period_end));
}
export const financialNumber = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
export function growth(current: unknown, previous: unknown): number | null {
  const a = financialNumber(current), b = financialNumber(previous);
  return a === null || b === null || b === 0 ? null : (a - b) / Math.abs(b) * 100;
}
/** Match calendar periods, never assume consecutive rows or a March financial year. */
export function comparisonPeriod(rows: FinancialPeriod[], row: FinancialPeriod, months: number) {
  const current = new Date(`${row.period_end}T00:00:00Z`);
  const target = current.getUTCFullYear() * 12 + current.getUTCMonth() - months;
  return rows.find(other => {
    const value = new Date(`${other.period_end}T00:00:00Z`);
    return value.getUTCFullYear() * 12 + value.getUTCMonth() === target;
  });
}
export function priceBandGuides(band: string | undefined, close: number, isFno?: boolean): number[] {
  if (isFno || !band || !/^\s*\d+(?:\.\d+)?\s*%?\s*$/.test(band)) return [];
  const percent = Number.parseFloat(band);
  if (!(percent > 0 && percent <= 20 && Number.isFinite(close) && close > 0)) return [];
  // Reference levels only; official tick rounding and exchange adjustments are not available.
  return [close * (1 + percent / 100), close * (1 - percent / 100)];
}

export function priceBandLabel(value?: string): string {
  if (!value?.trim()) return 'Unavailable';
  if (/^\s*\d+(?:\.\d+)?\s*%?\s*$/.test(value)) return `${Number.parseFloat(value)}%`;
  return /^no band$/i.test(value.trim()) ? 'No band' : value;
}
