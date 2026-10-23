import type { Candle } from './model';

/** Ported from the "Nexus Position Sizing Calculator" TradingView script (INR only: every Nexus symbol is on NSE). */
export type SizingSide = 'long' | 'short' | 'both';
export type SizingPosition = 'top-left' | 'top-center' | 'top-right' | 'middle-left' | 'middle-center' | 'middle-right' | 'bottom-left' | 'bottom-center' | 'bottom-right';
export type SizingTextSize = 'tiny' | 'small' | 'normal' | 'large' | 'huge';
export interface SizingStop { enabled: boolean; percent: number; color: string }
export interface PositionSizingConfig {
  enabled: boolean;
  side: SizingSide;
  capital: number;
  /** Portfolio risk per trade, in percent. */
  riskPercent: number;
  dayStopColor: string;
  prevStopColor: string;
  stops: SizingStop[];
  position: SizingPosition;
  textSize: SizingTextSize;
  showLines: boolean;
  showRiskAmount: boolean;
  lineOffset: number;
  lineLength: number;
  /** Where the table was dragged to, as fractions of the chart; null keeps `position`. */
  offset: {x: number; y: number} | null;
}

export const SIZING_POSITIONS: readonly [SizingPosition, string][] = [
  ['top-left', 'Top left'], ['top-center', 'Top center'], ['top-right', 'Top right'], ['middle-left', 'Middle left'], ['middle-center', 'Middle center'],
  ['middle-right', 'Middle right'], ['bottom-left', 'Bottom left'], ['bottom-center', 'Bottom center'], ['bottom-right', 'Bottom right'],
];
export const SIZING_TEXT_SIZES: readonly SizingTextSize[] = ['tiny', 'small', 'normal', 'large', 'huge'];

const DEFAULT_STOPS: SizingStop[] = [
  {enabled: true, percent: 2, color: '#f2df6c'}, {enabled: true, percent: 5, color: '#b23a3a'},
  {enabled: false, percent: 7.5, color: '#3a7bb2'}, {enabled: false, percent: 10, color: '#4b9b62'},
];
const DEFAULTS: PositionSizingConfig = {
  enabled: false, side: 'long', capital: 1_000_000, riskPercent: 0.5, dayStopColor: '#ff9800', prevStopColor: '#ff9800',
  stops: DEFAULT_STOPS, position: 'bottom-left', textSize: 'tiny', showLines: true, showRiskAmount: true, lineOffset: 3, lineLength: 4, offset: null,
};

const number = (value: unknown, fallback: number, min: number, max: number) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
const color = (value: unknown, fallback: string) => typeof value === 'string' && value ? value : fallback;

/** Fills defaults and clamps inputs to the script's ranges. */
export function positionSizingConfig(raw?: Partial<PositionSizingConfig>): PositionSizingConfig {
  const stops = Array.isArray(raw?.stops) ? raw.stops : [];
  const offset = raw?.offset && Number.isFinite(raw.offset.x) && Number.isFinite(raw.offset.y) ? raw.offset : null;
  return {
    enabled: raw?.enabled === true,
    side: raw?.side === 'short' || raw?.side === 'both' ? raw.side : 'long',
    capital: number(raw?.capital, DEFAULTS.capital, 0, 1e12),
    riskPercent: number(raw?.riskPercent, DEFAULTS.riskPercent, 0.01, 2),
    dayStopColor: color(raw?.dayStopColor, DEFAULTS.dayStopColor),
    prevStopColor: color(raw?.prevStopColor, DEFAULTS.prevStopColor),
    stops: DEFAULT_STOPS.map((fallback, index) => ({
      enabled: typeof stops[index]?.enabled === 'boolean' ? stops[index].enabled : fallback.enabled,
      percent: number(stops[index]?.percent, fallback.percent, 0.25, 10),
      color: color(stops[index]?.color, fallback.color),
    })),
    position: SIZING_POSITIONS.some(([id]) => id === raw?.position) ? raw!.position! : DEFAULTS.position,
    textSize: SIZING_TEXT_SIZES.includes(raw?.textSize as SizingTextSize) ? raw!.textSize! : DEFAULTS.textSize,
    showLines: raw?.showLines !== false,
    showRiskAmount: raw?.showRiskAmount !== false,
    lineOffset: Math.round(number(raw?.lineOffset, DEFAULTS.lineOffset, 0, 50)),
    lineLength: Math.round(number(raw?.lineLength, DEFAULTS.lineLength, 1, 20)),
    offset,
  };
}

export interface SizingRow { name: string; qty: number; stopPercent: number; stopPrice: number; allocationPercent: number; color: string; line: string }
export interface PositionSizing { long: boolean; close: number; rows: SizingRow[]; riskAmount: number }

/**
 * The table for the latest daily bar on or before `through`: DL/DH and PDL/PDH stops, then each enabled fixed-% stop.
 * Quantities floor to whole shares, as the script does for NSE symbols.
 */
export function positionSizing(daily: readonly Candle[], through: string, config: PositionSizingConfig): PositionSizing | null {
  let index = daily.length - 1;
  while (index >= 0 && daily[index].date > through) index--;
  const today = daily[index], previous = daily[index - 1];
  if (!today || !previous || !(today.close > 0) || !(previous.close > 0)) return null;
  const close = today.close, change = (close - previous.close) / previous.close * 100;
  const long = config.side === 'long' ? true : config.side === 'short' ? false : change >= 0;
  const riskAmount = config.capital * config.riskPercent / 100;
  // A zero distance (close at the day's low) would size an infinite position; the script floors it at one tick.
  const quantity = (distance: number) => Math.floor(riskAmount / Math.max(distance, 0.05));
  const row = (name: string, stopPrice: number, stopPercent: number, rowColor: string, line: string): SizingRow => {
    const qty = quantity(Math.abs(close - stopPrice));
    return {name, qty, stopPercent, stopPrice, allocationPercent: config.capital > 0 ? qty * close / config.capital * 100 : 0, color: rowColor, line};
  };
  const dayStop = long ? today.low : today.high, prevStop = long ? previous.low : previous.high;
  const rows = [
    row(long ? 'DL' : 'DH', dayStop, Math.abs(close - dayStop) / close * 100, config.dayStopColor, long ? 'DL' : 'DH'),
    row(long ? 'PDL' : 'PDH', prevStop, Math.abs(close - prevStop) / close * 100, config.prevStopColor, long ? 'PDL' : 'PDH'),
  ];
  config.stops.forEach((stop, index) => {
    if (!stop.enabled) return;
    const price = long ? close * (1 - stop.percent / 100) : close * (1 + stop.percent / 100);
    rows.push(row(`SL ${index + 1}`, price, stop.percent, stop.color, `${formatPercent(stop.percent)}`));
  });
  return {long, close, rows, riskAmount};
}

export const formatPercent = (value: number) => `${Number(value.toFixed(2))}%`;
