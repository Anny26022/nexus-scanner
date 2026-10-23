import type { Candle, EmaLine, Interval } from './model';
import type { ChartStudies } from './studies';
import { computeSimpleVolume } from './simpleVolume';

export interface IndicatorSnapshot {
  ema: Record<string, number | null>;
  volume: number | null;
  /** Simple Volume readouts: 50-bar SMA, volume as % of it, and the up/down volume ratio. */
  volumeAvg: number | null;
  volumeRel: number | null;
  volumeUpDown: number | null;
  /** 50-bar average traded value (close × volume), in ₹ crore. */
  volumeTurnoverAvg: number | null;
  /** Average volume per minute of the 375-minute NSE session × close, in ₹ lakh (an estimate from daily bars). */
  volumeMinuteLiquidity: number | null;
  supertrend: { value: number | null; direction: 1 | -1 } | null;
  bollinger: { upper: number | null; middle: number | null; lower: number | null } | null;
  sma: number | null;
  vwap: number | null;
  macd: { line: number | null; signal: number | null; histogram: number | null } | null;
  rsi: number | null;
  atr: number | null;
  stochastic: { k: number | null; d: number | null } | null;
  /** Registry studies keyed `${id}:${line}`. */
  extras: Record<string, number | null>;
}

const metricFormatter = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 });

const twoDecimals = new Intl.NumberFormat('en-IN', {minimumFractionDigits: 2, maximumFractionDigits: 2});
export const formatCrore = (value: number | null) => value === null || !Number.isFinite(value) ? '-' : `${twoDecimals.format(value)} Cr`;
export const formatLakh = (value: number | null) => value === null || !Number.isFinite(value) ? '-' : `${twoDecimals.format(value)} L`;
/** Relative volume as a multiple: 160% → "1.6x". */
export const formatTimes = (percent: number | null) => percent === null || !Number.isFinite(percent) ? '-' : `${(percent / 100).toFixed(1)}x`;

export function formatRelativeVolume(value: number | null): string {
  return value === null || !Number.isFinite(value) ? '-' : `${Math.round(value)}%`;
}

export function formatVolumeValue(volume: number | null): string {
  if (volume === null || !Number.isFinite(volume)) return '-';
  if (volume >= 1e7) return `${metricFormatter.format(volume / 1e7)}Cr`;
  if (volume >= 1e5) return `${metricFormatter.format(volume / 1e5)}L`;
  if (volume >= 1e3) return `${metricFormatter.format(volume / 1e3)}K`;
  return metricFormatter.format(volume);
}

export function formatIndicatorValue(value: number | null | undefined, precision = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '-';
  const digits = Number.isInteger(precision) ? Math.max(0, Math.min(10, precision)) : 2;
  return value.toFixed(digits);
}

import type { StudyConfigs } from './studyConfigs';
import { EXTRA_STUDY_BY_ID, enabledExtraStudies, studyParams } from './extraStudies';
import { studyKey, type StudyLines } from './studyCompute';
import { StudyStore } from './studyStore';

/**
 * Legend values at any bar. With the chart's study store it reads the results the chart already has (and
 * shows '-' for ones still computing); without one it computes them here.
 */
export function computeIndicatorSeries(
  candles: readonly Candle[],
  emaLines: readonly EmaLine[],
  studies: ChartStudies,
  studyConfigs?: StudyConfigs,
  benchmark?: ReadonlyMap<string, number>,
  interval: Interval = 'D',
  store?: StudyStore,
) {
  let local: StudyStore | undefined;
  if (!store) { local = new StudyStore(false); local.setInputs(candles, benchmark); }
  const missing: string[] = [];
  const read = (key: string): StudyLines | undefined => {
    if (local) return local.getNow(key);
    const lines = store!.take(key);
    if (!lines) missing.push(key);
    return lines;
  };
  const volumeStats = computeSimpleVolume(candles, {ppvLength: studyConfigs?.volume?.ppvLength, maLength: studyConfigs?.volume?.maLength});
  const turnoverLength = studyConfigs?.volume?.maLength ?? 50;
  const turnoverAvg: (number | null)[] = [];
  let turnoverSum = 0;
  candles.forEach((bar, index) => {
    turnoverSum += bar.close * (bar.volume ?? 0);
    if (index >= turnoverLength) turnoverSum -= candles[index - turnoverLength].close * (candles[index - turnoverLength].volume ?? 0);
    turnoverAvg.push(index >= turnoverLength - 1 ? turnoverSum / turnoverLength / 1e7 : null);
  });
  const emaMap = new Map<string, (number | null)[]>();
  for (const line of emaLines) {
    const values = read(studyKey.ema(line.period))?.value;
    if (values) emaMap.set(line.id, values);
  }
  const extraSeries = new Map<string, (number | null)[]>();
  for (const def of enabledExtraStudies(studyConfigs?.extras)) {
    const lines = read(studyKey.extra(def.id, studyParams(def, studyConfigs?.extras?.[def.id])));
    if (lines) for (const line of EXTRA_STUDY_BY_ID.get(def.id)!.lines) extraSeries.set(`${def.id}:${line.key}`, lines[line.key]);
  }

  const macdCfg = studyConfigs?.macd;
  const macdData = studies.macd ? read(studyKey.macd(macdCfg?.fast ?? 12, macdCfg?.slow ?? 26, macdCfg?.signal ?? 9, macdCfg?.source ?? 'close')) : undefined;
  const rsiCfg = studyConfigs?.rsi;
  const rsiData = studies.rsi ? read(studyKey.rsi(rsiCfg?.period ?? 14, rsiCfg?.source ?? 'close'))?.value : undefined;
  const atrData = studies.atr ? read(studyKey.atr(studyConfigs?.atr?.period ?? 14))?.value : undefined;
  const stochCfg = studyConfigs?.stochastic;
  const stochData = studies.stochastic ? read(studyKey.stochastic(stochCfg?.period ?? 14, stochCfg?.dPeriod ?? 3)) : undefined;
  const bbCfg = studyConfigs?.bollinger;
  const bbData = studies.bollinger ? read(studyKey.bollinger(bbCfg?.period ?? 20, bbCfg?.multiplier ?? 2, bbCfg?.source ?? 'close')) : undefined;
  const stCfg = studyConfigs?.supertrend;
  const stData = studies.supertrend ? read(studyKey.supertrend(stCfg?.period ?? 10, stCfg?.multiplier ?? 3)) : undefined;
  const smaCfg = studyConfigs?.sma;
  const smaData = studies.sma ? read(studyKey.sma(smaCfg?.period ?? 50, smaCfg?.source ?? 'close'))?.value : undefined;
  const vwapData = studies.vwap ? read(studyKey.vwap())?.value : undefined;
  if (missing.length) store?.request(missing);

  return {
    getSnapshot(index: number): IndicatorSnapshot {
      const idx = Math.max(0, Math.min(candles.length - 1, index));
      const bar = candles[idx];

      const emaVals: Record<string, number | null> = {};
      for (const [id, vals] of emaMap.entries()) {
        emaVals[id] = vals[idx] ?? null;
      }

      return {
        ema: emaVals,
        volume: bar ? bar.volume : null,
        volumeAvg: volumeStats.average[idx] ?? null,
        volumeRel: volumeStats.relative[idx] ?? null,
        volumeUpDown: volumeStats.upDown[idx] ?? null,
        volumeTurnoverAvg: turnoverAvg[idx] ?? null,
        volumeMinuteLiquidity: interval === 'D' && bar && volumeStats.average[idx] !== null && volumeStats.average[idx] !== undefined ? volumeStats.average[idx]! / 375 * bar.close / 1e5 : null,
        supertrend: stData
          ? { value: stData.value[idx] ?? null, direction: stData.direction[idx] === -1 ? -1 : 1 }
          : null,
        bollinger: bbData
          ? {
              upper: bbData.upper[idx] ?? null,
              middle: bbData.middle[idx] ?? null,
              lower: bbData.lower[idx] ?? null,
            }
          : null,
        sma: smaData ? smaData[idx] ?? null : null,
        vwap: vwapData ? vwapData[idx] ?? null : null,
        macd: macdData
          ? {
              line: macdData.line[idx] ?? null,
              signal: macdData.signal[idx] ?? null,
              histogram: macdData.histogram[idx] ?? null,
            }
          : null,
        rsi: rsiData ? rsiData[idx] ?? null : null,
        atr: atrData ? atrData[idx] ?? null : null,
        stochastic: stochData
          ? { k: stochData.k[idx] ?? null, d: stochData.d[idx] ?? null }
          : null,
        extras: Object.fromEntries([...extraSeries].map(([key, values]) => [key, values[idx] ?? null])),
      };
    },
  };
}

/**
 * 60/120fps direct DOM updater for live crosshair inspection
 */
export function updateLiveIndicatorDom(container: HTMLElement, snapshot: IndicatorSnapshot, configs?: StudyConfigs) {
  const formatted = formatIndicatorValue;
  for (const el of container.querySelectorAll<HTMLElement>('[data-ind-val]')) {
    const key = el.dataset.indVal;
    if (!key) continue;

    if (key.startsWith('x:')) {
      const [, id, line] = key.split(':');
      const precision = Number(el.dataset.indPrecision ?? 2);
      el.textContent = formatted(snapshot.extras[`${id}:${line}`], precision);
    } else if (key.startsWith('ema-')) {
      const id = key.slice(4);
      el.textContent = formatted(snapshot.ema[id]);
    } else if (key === 'vol' || key === 'volume-pane') {
      el.textContent = formatVolumeValue(snapshot.volume);
    } else if (key === 'vol-avg') {
      el.textContent = formatVolumeValue(snapshot.volumeAvg);
    } else if (key === 'vol-rel') {
      el.textContent = formatRelativeVolume(snapshot.volumeRel);
    } else if (key === 'vol-turnover') {
      el.textContent = formatCrore(snapshot.volumeTurnoverAvg);
    } else if (key === 'vol-proj') {
      el.textContent = formatTimes(snapshot.volumeRel);
    } else if (key === 'vol-1ml') {
      el.textContent = formatLakh(snapshot.volumeMinuteLiquidity);
    } else if (key === 'vol-ud') {
      el.textContent = formatted(snapshot.volumeUpDown, 2);
    } else if (key === 'macd-line') {
      el.textContent = formatted(snapshot.macd?.line, configs?.macd?.precision);
    } else if (key === 'macd-signal') {
      el.textContent = formatted(snapshot.macd?.signal, configs?.macd?.precision);
    } else if (key === 'macd-hist') {
      const v = snapshot.macd?.histogram;
      if (v !== null && v !== undefined) {
        el.textContent = formatted(v, configs?.macd?.precision);
        el.style.color = v >= 0 ? '#089981' : '#ef5350';
      } else {
        el.textContent = '-';
      }
    } else if (key === 'rsi') {
      el.textContent = formatted(snapshot.rsi, configs?.rsi?.precision);
    } else if (key === 'atr') {
      el.textContent = formatted(snapshot.atr, configs?.atr?.precision);
    } else if (key === 'stoch-k') {
      el.textContent = formatted(snapshot.stochastic?.k, configs?.stochastic?.precision);
    } else if (key === 'stoch-d') {
      el.textContent = formatted(snapshot.stochastic?.d, configs?.stochastic?.precision);
    } else if (key === 'supertrend') {
      const v = snapshot.supertrend?.value;
      if (v !== null && v !== undefined) {
        el.textContent = formatted(v, configs?.supertrend?.precision);
        el.style.color = snapshot.supertrend?.direction === 1 ? (configs?.supertrend?.upColor ?? '#089981') : (configs?.supertrend?.downColor ?? '#ef5350');
      } else {
        el.textContent = '-';
      }
    } else if (key === 'bb-upper') {
      el.textContent = formatted(snapshot.bollinger?.upper, configs?.bollinger?.precision);
    } else if (key === 'bb-mid') {
      el.textContent = formatted(snapshot.bollinger?.middle, configs?.bollinger?.precision);
    } else if (key === 'bb-lower') {
      el.textContent = formatted(snapshot.bollinger?.lower, configs?.bollinger?.precision);
    } else if (key === 'sma-50') {
      el.textContent = formatted(snapshot.sma, configs?.sma?.precision);
    } else if (key === 'vwap') {
      el.textContent = formatted(snapshot.vwap, configs?.vwap?.precision);
    }
  }
}
