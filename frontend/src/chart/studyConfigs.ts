import type { ExtraStudies } from './extraStudies';
export type PriceSource = 'close' | 'open' | 'high' | 'low' | 'hl2' | 'hlc3' | 'ohlc4';

export type PlotLineStyle = 'solid' | 'dashed' | 'dotted';

export interface IndicatorVisibility {
  intraday?: boolean;
  daily?: boolean;
  weekly?: boolean;
  monthly?: boolean;
}

export const defaultVisibility = (): IndicatorVisibility => ({
  intraday: true,
  daily: true,
  weekly: true,
  monthly: true,
});

export function isIndicatorVisibleForInterval(
  visibility?: IndicatorVisibility,
  interval?: string
): boolean {
  if (!visibility) return true;
  if (interval === 'D') return visibility.daily !== false;
  if (interval === 'W') return visibility.weekly !== false;
  if (interval === 'M') return visibility.monthly !== false;
  return visibility.intraday !== false;
}

export interface RsiConfig {
  period: number;
  source?: PriceSource;
  color: string;
  lineWidth?: number;
  lineStyle?: PlotLineStyle;
  lineVisible?: boolean;
  overbought: number;
  oversold: number;
  bandsVisible?: boolean;
  bandColor?: string;
  visibility?: IndicatorVisibility;
  precision?: number;
}

export interface MacdConfig {
  fast: number;
  slow: number;
  signal: number;
  source?: PriceSource;
  macdVisible?: boolean;
  macdColor: string;
  macdWidth?: number;
  macdStyle?: PlotLineStyle;
  signalVisible?: boolean;
  signalColor: string;
  signalWidth?: number;
  signalStyle?: PlotLineStyle;
  histVisible?: boolean;
  histColor: string;
  visibility?: IndicatorVisibility;
  precision?: number;
}

export interface SupertrendConfig {
  period: number;
  multiplier: number;
  upColor: string;
  downColor: string;
  lineWidth?: number;
  lineStyle?: PlotLineStyle;
  visibility?: IndicatorVisibility;
  precision?: number;
}

export interface BollingerConfig {
  period: number;
  multiplier: number;
  source?: PriceSource;
  upperVisible?: boolean;
  upperColor: string;
  upperWidth?: number;
  upperStyle?: PlotLineStyle;
  middleVisible?: boolean;
  middleColor: string;
  middleWidth?: number;
  middleStyle?: PlotLineStyle;
  lowerVisible?: boolean;
  lowerColor: string;
  lowerWidth?: number;
  lowerStyle?: PlotLineStyle;
  visibility?: IndicatorVisibility;
  precision?: number;
}

export interface SmaConfig {
  period: number;
  source?: PriceSource;
  visible?: boolean;
  color: string;
  lineWidth?: number;
  lineStyle?: PlotLineStyle;
  visibility?: IndicatorVisibility;
  precision?: number;
}

export interface AtrConfig {
  period: number;
  visible?: boolean;
  color: string;
  lineWidth?: number;
  lineStyle?: PlotLineStyle;
  visibility?: IndicatorVisibility;
  precision?: number;
}

export interface StochasticConfig {
  period: number;
  dPeriod: number;
  kVisible?: boolean;
  kColor: string;
  kWidth?: number;
  kStyle?: PlotLineStyle;
  dVisible?: boolean;
  dColor: string;
  dWidth?: number;
  dStyle?: PlotLineStyle;
  upper: number;
  lower: number;
  bandsVisible?: boolean;
  bandColor?: string;
  visibility?: IndicatorVisibility;
  precision?: number;
}

export interface VwapConfig {
  visible?: boolean;
  color: string;
  lineWidth?: number;
  lineStyle?: PlotLineStyle;
  visibility?: IndicatorVisibility;
  precision?: number;
}

export interface VolumeConfig {
  separatePane: boolean;
  upColor: string;
  downColor: string;
  visibility?: IndicatorVisibility;
}

export interface StudyConfigs {
  /** Registry indicators (see extraStudies.ts), persisted with the scene and saved layouts. */
  extras?: ExtraStudies;
  rsi?: RsiConfig;
  macd?: MacdConfig;
  supertrend?: SupertrendConfig;
  bollinger?: BollingerConfig;
  sma?: SmaConfig;
  atr?: AtrConfig;
  stochastic?: StochasticConfig;
  vwap?: VwapConfig;
  volume?: VolumeConfig;
}

export const defaultStudyConfigs = (): StudyConfigs => ({
  rsi: {
    period: 14,
    source: 'close',
    color: '#8b5cf6',
    lineWidth: 1,
    lineStyle: 'solid',
    lineVisible: true,
    overbought: 70,
    oversold: 30,
    bandsVisible: true,
    bandColor: '#aab8c5',
    visibility: defaultVisibility(),
    precision: 2,
  },
  macd: {
    fast: 12,
    slow: 26,
    signal: 9,
    source: 'close',
    macdVisible: true,
    macdColor: '#187669',
    macdWidth: 1,
    macdStyle: 'solid',
    signalVisible: true,
    signalColor: '#f59e0b',
    signalWidth: 1,
    signalStyle: 'solid',
    histVisible: true,
    histColor: '#089981',
    visibility: defaultVisibility(),
    precision: 2,
  },
  supertrend: {
    period: 10,
    multiplier: 3,
    upColor: '#089981',
    downColor: '#ef5350',
    lineWidth: 2,
    lineStyle: 'solid',
    visibility: defaultVisibility(),
    precision: 2,
  },
  bollinger: {
    period: 20,
    multiplier: 2,
    source: 'close',
    upperVisible: true,
    upperColor: '#78909c',
    upperWidth: 1,
    upperStyle: 'solid',
    middleVisible: true,
    middleColor: '#78909c',
    middleWidth: 1,
    middleStyle: 'dashed',
    lowerVisible: true,
    lowerColor: '#78909c',
    lowerWidth: 1,
    lowerStyle: 'solid',
    visibility: defaultVisibility(),
    precision: 2,
  },
  sma: {
    period: 50,
    source: 'close',
    visible: true,
    color: '#3b82f6',
    lineWidth: 1,
    lineStyle: 'solid',
    visibility: defaultVisibility(),
    precision: 2,
  },
  atr: {
    period: 14,
    visible: true,
    color: '#e09b26',
    lineWidth: 1,
    lineStyle: 'solid',
    visibility: defaultVisibility(),
    precision: 2,
  },
  stochastic: {
    period: 14,
    dPeriod: 3,
    kVisible: true,
    kColor: '#187669',
    kWidth: 1,
    kStyle: 'solid',
    dVisible: true,
    dColor: '#ef5350',
    dWidth: 1,
    dStyle: 'solid',
    upper: 80,
    lower: 20,
    bandsVisible: true,
    bandColor: '#aab8c5',
    visibility: defaultVisibility(),
    precision: 2,
  },
  vwap: {
    visible: true,
    color: '#e09b26',
    lineWidth: 1,
    lineStyle: 'solid',
    visibility: { intraday: false, daily: true, weekly: false, monthly: false },
    precision: 2,
  },
  volume: {
    separatePane: true,
    upColor: '#089981',
    downColor: '#ef5350',
    visibility: defaultVisibility(),
  },
});
