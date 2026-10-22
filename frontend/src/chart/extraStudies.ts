import { ema, type Candle } from './model';
import { atr, sma } from './studies';

/**
 * Declarative indicators: each entry defines inputs, plotted lines and a pure
 * calculation. The engine, legends, crosshair values and settings render any
 * entry generically, so adding an indicator only needs a new registry item.
 */
export type ExtraStudyId = 'rs' | 'adx' | 'obv' | 'donchian' | 'keltner' | 'psar' | 'cci' | 'williamsR' | 'roc' | 'mfi' | 'cmf';
type Series = (number | null)[];

export interface StudyInput { id: string; label: string; default: number; min: number; max: number; step?: number }
export interface StudyLine { key: string; label: string; color: string; dashed?: boolean; dots?: boolean }
export interface StudyContext { benchmark?: ReadonlyMap<string, number> }
export interface ExtraStudyDef {
  id: ExtraStudyId;
  label: string;
  short: string;
  description: string;
  category: 'Relative strength' | 'Trend' | 'Momentum' | 'Volume' | 'Volatility';
  pane: 'price' | 'separate';
  inputs: StudyInput[];
  lines: StudyLine[];
  levels?: number[];
  precision: number;
  /** Daily-only studies are hidden on weekly and monthly candles. */
  dailyOnly?: boolean;
  compute(candles: readonly Candle[], params: Record<string, number>, context: StudyContext): Record<string, Series>;
}

export interface ExtraStudyState { enabled: boolean; params?: Record<string, number>; colors?: Record<string, string> }
export type ExtraStudies = Partial<Record<ExtraStudyId, ExtraStudyState>>;

const highest = (values: readonly number[]) => values.reduce((a, b) => Math.max(a, b), -Infinity);
const lowest = (values: readonly number[]) => values.reduce((a, b) => Math.min(a, b), Infinity);

/** Wilder smoothing of a series that starts at `start`; values before it are null. */
function wilder(values: readonly number[], period: number, start = 0): Series {
  let value = 0;
  return values.map((item, index) => {
    if (index < start) return null;
    const offset = index - start;
    if (offset < period) { value += item; return offset === period - 1 ? (value /= period) : null; }
    value = (value * (period - 1) + item) / period;
    return value;
  });
}

/** Ratio of the symbol's close to the benchmark close at each bar's last session, rebased to 100. */
export function relativeStrength(candles: readonly Candle[], benchmark: ReadonlyMap<string, number> | undefined): Series {
  if (!benchmark?.size) return candles.map(() => null);
  const dates = [...benchmark.keys()].sort();
  let pointer = 0, base: number | null = null;
  return candles.map((bar, index) => {
    // Weekly/monthly bars are stamped with their first session; use the benchmark close before the next bar starts.
    const end = candles[index + 1]?.date;
    while (pointer < dates.length && (end ? dates[pointer] < end : true)) pointer++;
    const date = dates[pointer - 1];
    if (!date || date < bar.date) return null;
    const close = benchmark.get(date);
    if (!close || !Number.isFinite(close)) return null;
    const ratio = bar.close / close;
    base ??= ratio;
    return (ratio / base) * 100;
  });
}

export function adx(candles: readonly Candle[], period = 14) {
  const plusDm: number[] = [], minusDm: number[] = [], tr: number[] = [];
  candles.forEach((bar, index) => {
    const previous = candles[index - 1];
    if (!previous) { plusDm.push(0); minusDm.push(0); tr.push(bar.high - bar.low); return; }
    const up = bar.high - previous.high, down = previous.low - bar.low;
    plusDm.push(up > down && up > 0 ? up : 0);
    minusDm.push(down > up && down > 0 ? down : 0);
    tr.push(Math.max(bar.high - bar.low, Math.abs(bar.high - previous.close), Math.abs(bar.low - previous.close)));
  });
  const smoothTr = wilder(tr, period, 1), smoothPlus = wilder(plusDm, period, 1), smoothMinus = wilder(minusDm, period, 1);
  const plusDi = smoothTr.map((value, index) => value ? 100 * smoothPlus[index]! / value : null);
  const minusDi = smoothTr.map((value, index) => value ? 100 * smoothMinus[index]! / value : null);
  const dx = plusDi.map((plus, index) => {
    const minus = minusDi[index];
    return plus === null || minus === null || plus + minus === 0 ? null : 100 * Math.abs(plus - minus) / (plus + minus);
  });
  const firstDx = dx.findIndex(value => value !== null);
  const adxLine = firstDx < 0 ? dx.map(() => null) : wilder(dx.map(value => value ?? 0), period, firstDx);
  return {adx: adxLine, plusDi, minusDi};
}

export function obv(candles: readonly Candle[]): Series {
  let total = 0;
  return candles.map((bar, index) => {
    const previous = candles[index - 1];
    if (previous && bar.volume !== null) total += bar.close > previous.close ? bar.volume : bar.close < previous.close ? -bar.volume : 0;
    return index === 0 && bar.volume === null ? null : total;
  });
}

export function donchian(candles: readonly Candle[], period = 20) {
  const upper = candles.map((_, index) => index < period - 1 ? null : highest(candles.slice(index - period + 1, index + 1).map(bar => bar.high)));
  const lower = candles.map((_, index) => index < period - 1 ? null : lowest(candles.slice(index - period + 1, index + 1).map(bar => bar.low)));
  return {upper, lower, middle: upper.map((value, index) => value === null ? null : (value + lower[index]!) / 2)};
}

export function keltner(candles: readonly Candle[], period = 20, multiplier = 2, atrPeriod = 10) {
  const middle = ema(candles, period), range = atr(candles, atrPeriod);
  return {
    middle,
    upper: middle.map((value, index) => value === null || range[index] === null ? null : value + multiplier * range[index]!),
    lower: middle.map((value, index) => value === null || range[index] === null ? null : value - multiplier * range[index]!),
  };
}

export function parabolicSar(candles: readonly Candle[], step = 0.02, maxStep = 0.2): Series {
  if (candles.length < 2) return candles.map(() => null);
  let rising = candles[1].close >= candles[0].close;
  let sar = rising ? candles[0].low : candles[0].high;
  let extreme = rising ? candles[0].high : candles[0].low;
  let factor = step;
  return candles.map((bar, index) => {
    if (index === 0) return null;
    const previous = candles[index - 1], before = candles[index - 2] ?? previous;
    sar += factor * (extreme - sar);
    // SAR never moves into the prior two bars' range.
    sar = rising ? Math.min(sar, previous.low, before.low) : Math.max(sar, previous.high, before.high);
    if (rising ? bar.low < sar : bar.high > sar) {
      rising = !rising;
      sar = extreme;
      extreme = rising ? bar.high : bar.low;
      factor = step;
    } else if (rising ? bar.high > extreme : bar.low < extreme) {
      extreme = rising ? bar.high : bar.low;
      factor = Math.min(maxStep, factor + step);
    }
    return sar;
  });
}

export function cci(candles: readonly Candle[], period = 20): Series {
  const typical = candles.map(bar => (bar.high + bar.low + bar.close) / 3);
  const mean = sma(typical, period);
  return typical.map((value, index) => {
    if (mean[index] === null) return null;
    const window = typical.slice(index - period + 1, index + 1);
    const deviation = window.reduce((sum, item) => sum + Math.abs(item - mean[index]!), 0) / period;
    return deviation === 0 ? 0 : (value - mean[index]!) / (0.015 * deviation);
  });
}

export function williamsR(candles: readonly Candle[], period = 14): Series {
  return candles.map((bar, index) => {
    if (index < period - 1) return null;
    const window = candles.slice(index - period + 1, index + 1);
    const high = highest(window.map(item => item.high)), low = lowest(window.map(item => item.low));
    return high === low ? -50 : -100 * (high - bar.close) / (high - low);
  });
}

export function rateOfChange(candles: readonly Candle[], period = 12): Series {
  return candles.map((bar, index) => {
    const past = candles[index - period]?.close;
    return past ? 100 * (bar.close / past - 1) : null;
  });
}

export function moneyFlowIndex(candles: readonly Candle[], period = 14): Series {
  const typical = candles.map(bar => (bar.high + bar.low + bar.close) / 3);
  return candles.map((_, index) => {
    if (index < period) return null;
    let positive = 0, negative = 0;
    for (let i = index - period + 1; i <= index; i++) {
      const volume = candles[i].volume;
      if (volume === null) return null;
      const flow = typical[i] * volume;
      if (typical[i] > typical[i - 1]) positive += flow;
      else if (typical[i] < typical[i - 1]) negative += flow;
    }
    return negative === 0 ? 100 : 100 - 100 / (1 + positive / negative);
  });
}

export function chaikinMoneyFlow(candles: readonly Candle[], period = 20): Series {
  return candles.map((_, index) => {
    if (index < period - 1) return null;
    let flow = 0, volume = 0;
    for (const bar of candles.slice(index - period + 1, index + 1)) {
      if (bar.volume === null) return null;
      const multiplier = bar.high === bar.low ? 0 : ((bar.close - bar.low) - (bar.high - bar.close)) / (bar.high - bar.low);
      flow += multiplier * bar.volume;
      volume += bar.volume;
    }
    return volume === 0 ? null : flow / volume;
  });
}

export const EXTRA_STUDIES: readonly ExtraStudyDef[] = [
  {
    id: 'rs', label: 'Relative Strength vs Nifty 50', short: 'RS', category: 'Relative strength', pane: 'separate', precision: 2,
    description: 'Price relative to the Nifty 50, rebased to 100. A rising line means the stock is outperforming the market.',
    inputs: [{id: 'maPeriod', label: 'Moving average', default: 50, min: 0, max: 400}],
    lines: [{key: 'rs', label: 'RS', color: '#2962ff'}, {key: 'ma', label: 'MA', color: '#ff9800', dashed: true}],
    compute: (candles, params, context) => {
      const rs = relativeStrength(candles, context.benchmark);
      return {rs, ma: params.maPeriod > 1 ? sma(rs, params.maPeriod) : rs.map(() => null)};
    },
  },
  {
    id: 'adx', label: 'ADX / DMI', short: 'ADX', category: 'Trend', pane: 'separate', precision: 2, levels: [25],
    description: 'Average Directional Index with +DI and -DI. Above 25 signals a trending market.',
    inputs: [{id: 'period', label: 'Length', default: 14, min: 2, max: 100}],
    lines: [{key: 'adx', label: 'ADX', color: '#ff6d00'}, {key: 'plusDi', label: '+DI', color: '#089981'}, {key: 'minusDi', label: '-DI', color: '#f23645'}],
    compute: (candles, params) => adx(candles, params.period),
  },
  {
    id: 'obv', label: 'On-Balance Volume', short: 'OBV', category: 'Volume', pane: 'separate', precision: 0,
    description: 'Running total of volume on up days minus down days. Confirms price trends with volume.',
    inputs: [],
    lines: [{key: 'obv', label: 'OBV', color: '#2962ff'}],
    compute: candles => ({obv: obv(candles)}),
  },
  {
    id: 'mfi', label: 'Money Flow Index', short: 'MFI', category: 'Volume', pane: 'separate', precision: 2, levels: [80, 20],
    description: 'Volume-weighted RSI. Above 80 is overbought, below 20 oversold.',
    inputs: [{id: 'period', label: 'Length', default: 14, min: 2, max: 100}],
    lines: [{key: 'mfi', label: 'MFI', color: '#7e57c2'}],
    compute: (candles, params) => ({mfi: moneyFlowIndex(candles, params.period)}),
  },
  {
    id: 'cmf', label: 'Chaikin Money Flow', short: 'CMF', category: 'Volume', pane: 'separate', precision: 3, levels: [0],
    description: 'Buying versus selling pressure over the period. Positive values show accumulation.',
    inputs: [{id: 'period', label: 'Length', default: 20, min: 2, max: 100}],
    lines: [{key: 'cmf', label: 'CMF', color: '#00897b'}],
    compute: (candles, params) => ({cmf: chaikinMoneyFlow(candles, params.period)}),
  },
  {
    id: 'donchian', label: 'Donchian Channels', short: 'DC', category: 'Volatility', pane: 'price', precision: 2,
    description: 'Highest high and lowest low of the period. Closes outside the channel mark breakouts.',
    inputs: [{id: 'period', label: 'Length', default: 20, min: 2, max: 400}],
    lines: [{key: 'upper', label: 'Upper', color: '#2962ff'}, {key: 'middle', label: 'Basis', color: '#ff6d00', dashed: true}, {key: 'lower', label: 'Lower', color: '#2962ff'}],
    compute: (candles, params) => donchian(candles, params.period),
  },
  {
    id: 'keltner', label: 'Keltner Channels', short: 'KC', category: 'Volatility', pane: 'price', precision: 2,
    description: 'EMA basis with ATR bands. Narrow channels often precede expansion.',
    inputs: [{id: 'period', label: 'Length', default: 20, min: 2, max: 400}, {id: 'multiplier', label: 'Multiplier', default: 2, min: 0.5, max: 10, step: 0.5}, {id: 'atrPeriod', label: 'ATR length', default: 10, min: 2, max: 100}],
    lines: [{key: 'upper', label: 'Upper', color: '#2962ff'}, {key: 'middle', label: 'Basis', color: '#ff6d00'}, {key: 'lower', label: 'Lower', color: '#2962ff'}],
    compute: (candles, params) => keltner(candles, params.period, params.multiplier, params.atrPeriod),
  },
  {
    id: 'psar', label: 'Parabolic SAR', short: 'SAR', category: 'Trend', pane: 'price', precision: 2,
    description: 'Trailing stop-and-reverse dots. Dots below price signal an uptrend.',
    inputs: [{id: 'step', label: 'Step', default: 0.02, min: 0.005, max: 0.2, step: 0.005}, {id: 'maxStep', label: 'Maximum', default: 0.2, min: 0.05, max: 1, step: 0.05}],
    lines: [{key: 'sar', label: 'SAR', color: '#2962ff', dots: true}],
    compute: (candles, params) => ({sar: parabolicSar(candles, params.step, params.maxStep)}),
  },
  {
    id: 'cci', label: 'Commodity Channel Index', short: 'CCI', category: 'Momentum', pane: 'separate', precision: 2, levels: [100, -100],
    description: 'Distance of price from its average. Readings beyond ±100 flag strong moves.',
    inputs: [{id: 'period', label: 'Length', default: 20, min: 2, max: 200}],
    lines: [{key: 'cci', label: 'CCI', color: '#2962ff'}],
    compute: (candles, params) => ({cci: cci(candles, params.period)}),
  },
  {
    id: 'williamsR', label: 'Williams %R', short: '%R', category: 'Momentum', pane: 'separate', precision: 2, levels: [-20, -80],
    description: 'Close relative to the period range. Above -20 is overbought, below -80 oversold.',
    inputs: [{id: 'period', label: 'Length', default: 14, min: 2, max: 200}],
    lines: [{key: 'r', label: '%R', color: '#7e57c2'}],
    compute: (candles, params) => ({r: williamsR(candles, params.period)}),
  },
  {
    id: 'roc', label: 'Rate of Change', short: 'ROC', category: 'Momentum', pane: 'separate', precision: 2, levels: [0],
    description: 'Percentage change versus N bars ago.',
    inputs: [{id: 'period', label: 'Length', default: 12, min: 1, max: 400}],
    lines: [{key: 'roc', label: 'ROC', color: '#2962ff'}],
    compute: (candles, params) => ({roc: rateOfChange(candles, params.period)}),
  },
];

export const EXTRA_STUDY_BY_ID = new Map(EXTRA_STUDIES.map(def => [def.id, def]));

export function studyParams(def: ExtraStudyDef, state?: ExtraStudyState): Record<string, number> {
  return Object.fromEntries(def.inputs.map(input => {
    const value = state?.params?.[input.id];
    return [input.id, typeof value === 'number' && Number.isFinite(value) ? Math.min(input.max, Math.max(input.min, value)) : input.default];
  }));
}

export function studyLineColor(line: StudyLine, state?: ExtraStudyState) {
  const color = state?.colors?.[line.key];
  return typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color) ? color : line.color;
}

export function studyTitle(def: ExtraStudyDef, params: Record<string, number>) {
  const values = def.inputs.map(input => params[input.id]).filter(value => value !== 0);
  return values.length ? `${def.short} ${values.join(' ')}` : def.short;
}

export function enabledExtraStudies(extras: ExtraStudies | undefined): ExtraStudyDef[] {
  return EXTRA_STUDIES.filter(def => extras?.[def.id]?.enabled);
}

/** Computes every enabled study once; keyed `${id}:${line}` for legends and crosshair values. */
export function computeExtraStudies(candles: readonly Candle[], extras: ExtraStudies | undefined, context: StudyContext) {
  const out = new Map<string, Series>();
  for (const def of enabledExtraStudies(extras)) {
    const values = def.compute(candles, studyParams(def, extras?.[def.id]), context);
    for (const line of def.lines) out.set(`${def.id}:${line.key}`, values[line.key] ?? candles.map(() => null));
  }
  return out;
}
