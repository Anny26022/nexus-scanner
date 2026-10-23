import { ema, type Candle } from './model';
import { atr, bollinger, getPriceSource, macd, monthlyVwap, rsi, sma, stochastic, supertrend } from './studies';
import { EXTRA_STUDY_BY_ID, type ExtraStudyId } from './extraStudies';
import type { PriceSource } from './studyConfigs';

/** One computed indicator: its named output lines, one value per candle (null before it is defined). */
export type StudyLines = Record<string, (number | null)[]>;

/**
 * Stable keys name an indicator and its inputs, so a result computed once is reused by the chart, its legend
 * and replay. Every indicator here is causal (bar i only uses bars up to i), so values computed over the
 * full history are also correct for any replayed prefix of it.
 */
export const studyKey = {
  ema: (period: number) => `ema:${period}`,
  rsi: (period: number, source: PriceSource) => `rsi:${period}:${source}`,
  macd: (fast: number, slow: number, signal: number, source: PriceSource) => `macd:${fast}:${slow}:${signal}:${source}`,
  sma: (period: number, source: PriceSource) => `sma:${period}:${source}`,
  bollinger: (period: number, multiplier: number, source: PriceSource) => `bb:${period}:${multiplier}:${source}`,
  vwap: () => 'vwap',
  atr: (period: number) => `atr:${period}`,
  stochastic: (period: number, dPeriod: number) => `stoch:${period}:${dPeriod}`,
  supertrend: (period: number, multiplier: number) => `st:${period}:${multiplier}`,
  extra: (id: ExtraStudyId, params: Record<string, number>) =>
    `x:${id}:${Object.keys(params).sort().map(name => `${name}=${params[name]}`).join(',')}`,
};

const number = (value: string) => Number(value);

/** Computes one keyed indicator. Pure, so it runs the same on the main thread and in the study worker. */
export function computeStudy(key: string, candles: readonly Candle[], benchmark?: ReadonlyMap<string, number>): StudyLines {
  const [kind, ...parts] = key.split(':');
  switch (kind) {
    case 'ema': return {value: ema(candles, number(parts[0]))};
    case 'rsi': return {value: rsi(candles, number(parts[0]), parts[1] as PriceSource)};
    case 'macd': {
      const {line, signal, histogram} = macd(candles, number(parts[0]), number(parts[1]), number(parts[2]), parts[3] as PriceSource);
      return {line, signal, histogram};
    }
    case 'sma': return {value: sma(candles.map(bar => getPriceSource(bar, parts[1] as PriceSource)), number(parts[0]))};
    case 'bb': {
      const {upper, middle, lower} = bollinger(candles, number(parts[0]), number(parts[1]), parts[2] as PriceSource);
      return {upper, middle, lower};
    }
    case 'vwap': return {value: monthlyVwap(candles)};
    case 'atr': return {value: atr(candles, number(parts[0]))};
    case 'stoch': {
      const {k, d} = stochastic(candles, number(parts[0]), number(parts[1]));
      return {k, d};
    }
    case 'st': {
      const {values, directions} = supertrend(candles, number(parts[0]), number(parts[1]));
      return {value: values, direction: directions};
    }
    case 'x': {
      const def = EXTRA_STUDY_BY_ID.get(parts[0] as ExtraStudyId);
      if (!def) throw new Error(`Unknown study ${parts[0]}`);
      const params = Object.fromEntries((parts[1] ?? '').split(',').filter(Boolean).map(pair => {
        const [name, value] = pair.split('=');
        return [name, number(value)];
      }));
      const values = def.compute(candles, params, {benchmark});
      return Object.fromEntries(def.lines.map(line => [line.key, values[line.key] ?? candles.map(() => null)]));
    }
    default: throw new Error(`Unknown study ${key}`);
  }
}

/** Whether a study reads the benchmark, so a late benchmark only invalidates those results. */
export const usesBenchmark = (key: string) => key.startsWith('x:rs:');
