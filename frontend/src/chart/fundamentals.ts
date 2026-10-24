/** Statement amounts are INR crore; EPS is INR/share, margins are percent. */
export interface FinancialPeriod {
  period_end: string;
  filing_date?: string;
  [metric: string]: number | string | null | undefined;
}
export interface FinancialHistory {
  report_type: string;
  amount_unit: string;
  observed_on: string;
  quarterly: FinancialPeriod[];
  annual: FinancialPeriod[];
}
/**
 * "Price Band & Results" indicator settings. Saved as `studyConfigs.fundamentals`.
 * Mirrors the Price Band extension: a band badge (band %, results countdown,
 * ASM/GSM status) and a separate results card, each draggable on the chart.
 */
export interface FundamentalsConfig {
  enabled: boolean;
  /** Band badge with results countdown and surveillance status. */
  band?: boolean;
  resultDate?: boolean;
  /** Results card. */
  table?: boolean;
  layout?: 'compact' | 'results' | 'essential';
  period?: 'quarterly' | 'annual';
  profit?: 'eps' | 'net_profit';
  count?: number;
  /** Upper and lower circuit (UC/LC) price lines for the next session. */
  guides?: boolean;
  earningsMarkers?: boolean;
  /** Purple "E" on the upcoming results date (within 90 days), and an optional dotted line there. */
  earningsLabel?: boolean;
  earningsLine?: boolean;
  /** Labels on past price-band change dates. */
  bandHistory?: boolean;
  /** Colour, shape and visibility of each band's change marker, keyed '20' | '10' | '5' | '2' | 'NB'. */
  bandStyles?: Partial<Record<string, import('./markerShapes').MarkerStyle>>;
  /** Drag positions as fractions of the free space in the chart (null = default corner). */
  badgeOffset?: {x: number; y: number} | null;
  offset?: {x: number; y: number} | null;
  badgeScale?: number;
  tableScale?: number;
  /** Older saves: table text size in px and preset position. */
  fontSize?: number;
  position?: string;
}
export const fundamentalsDefaults: FundamentalsConfig = {
  enabled: false, band: true, resultDate: true, table: true, layout: 'compact', period: 'quarterly', profit: 'eps', count: 5,
  guides: true, earningsMarkers: true, earningsLabel: true, earningsLine: false, bandHistory: true, bandStyles: {}, badgeOffset: null, offset: null, badgeScale: 1, tableScale: 1,
};
const point = (value?: {x: number; y: number} | null) => value && Number.isFinite(value.x) && Number.isFinite(value.y)
  ? {x: Math.max(0, Math.min(1, value.x)), y: Math.max(0, Math.min(1, value.y))} : null;
const scale = (value: unknown, fallback: number) => typeof value === 'number' && Number.isFinite(value) ? Math.max(0.8, Math.min(1.5, Math.round(value * 20) / 20)) : fallback;
export function fundamentalsConfig(raw?: FundamentalsConfig): Required<FundamentalsConfig> {
  return {
    ...fundamentalsDefaults, ...raw, enabled: raw?.enabled === true,
    band: raw?.band !== false, resultDate: raw?.resultDate !== false, table: raw?.table !== false,
    layout: ['compact', 'results', 'essential'].includes(raw?.layout ?? '') ? raw!.layout! : 'compact',
    period: raw?.period === 'annual' ? 'annual' : 'quarterly',
    profit: raw?.profit === 'net_profit' ? 'net_profit' : 'eps',
    count: Math.max(3, Math.min(13, Math.round(raw?.count ?? 5) || 5)),
    guides: raw?.guides !== false, earningsMarkers: raw?.earningsMarkers !== false,
    earningsLabel: raw?.earningsLabel !== false, earningsLine: raw?.earningsLine === true, bandHistory: raw?.bandHistory !== false,
    badgeOffset: point(raw?.badgeOffset), offset: point(raw?.offset),
    bandStyles: raw?.bandStyles && typeof raw.bandStyles === 'object' ? raw.bandStyles : {},
    badgeScale: scale(raw?.badgeScale, 1),
    // Older saves stored a table text size (10–15px, 11 default).
    tableScale: scale(raw?.tableScale, typeof raw?.fontSize === 'number' ? raw.fontSize / 11 : 1),
    fontSize: 11, position: 'top-right',
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

/** Band percentage for badge colouring: 20, 10, 5, 2; null for no band or F&O. */
export function priceBandPercent(value?: string): number | null {
  return value && /^\s*\d+(?:\.\d+)?\s*%?\s*$/.test(value) ? Number.parseFloat(value) : null;
}

/** "TODAY", "TOMORROW", "12 DAYS" until a results date, counting from `from` (both YYYY-MM-DD). */
export function resultsCountdown(date: string, from: string): string {
  const days = Math.round((Date.parse(date) - Date.parse(from)) / 86_400_000);
  if (days <= 0) return 'TODAY';
  if (days === 1) return 'TOMORROW';
  return `${days} DAYS`;
}

/** Surveillance label as the exchange writes it, e.g. "LTASM - I", "GSM 0", "ASM STAGE II". */
export function surveillanceLabels(meta: {isAsm?: boolean | null; asmStage?: string | null; isGsm?: boolean | null; gsmStage?: string | null}): string[] {
  const label = (kind: string, stage?: string | null) => {
    // Stages arrive as e.g. "LTASM - I (13)"; the bracketed number is an internal code.
    const clean = stage?.replace(/\s*\(\d+\)\s*$/, '').trim().toUpperCase() ?? '';
    if (!clean) return kind;
    return clean.includes(kind) ? clean : `${kind} ${clean}`;
  };
  return [meta.isAsm ? label('ASM', meta.asmStage) : '', meta.isGsm ? label('GSM', meta.gsmStage) : ''].filter(Boolean);
}

export function priceBandLabel(value?: string): string {
  if (!value?.trim()) return 'Unavailable';
  if (/^\s*\d+(?:\.\d+)?\s*%?\s*$/.test(value)) return `${Number.parseFloat(value)}%`;
  return /^no band$/i.test(value.trim()) ? 'No band' : value;
}

/** The next scheduled results date on or after `cutoff`, within `days`; null when the calendar wasn't observed by then. */
export function upcomingResults(schedule: {observedOn?: string; events: {scheduled_date: string; date_conflict?: boolean}[]} | null | undefined, cutoff: string, days = 90) {
  if (!schedule?.observedOn || schedule.observedOn > cutoff) return null;
  const limit = new Date(`${cutoff}T00:00:00Z`);
  limit.setUTCDate(limit.getUTCDate() + days);
  const last = limit.toISOString().slice(0, 10);
  return schedule.events.filter(event => /^\d{4}-\d{2}-\d{2}$/.test(event.scheduled_date) && event.scheduled_date >= cutoff && event.scheduled_date <= last)
    .sort((a, b) => a.scheduled_date.localeCompare(b.scheduled_date))[0] ?? null;
}

/** Band changes from a symbol's dated bands ([date, band], first = starting band) up to `cutoff`. */
export function bandChanges(bands: readonly (readonly [string, string])[] | undefined, cutoff: string) {
  const changes: {date: string; from: string; to: string}[] = [];
  for (let index = 1; index < (bands?.length ?? 0); index++) {
    const [date, to] = bands![index];
    if (date > cutoff) break;
    changes.push({date, from: bands![index - 1][1], to});
  }
  return changes;
}

export const BAND_MARKERS = [['20', '20%', '#2962ff'], ['10', '10%', '#4caf50'], ['5', '5%', '#fbc02d'], ['2', '2%', '#f23645'], ['NB', 'No band', '#9598a1']] as const;
