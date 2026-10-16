import { ema, type Candle, type EmaLine } from './model';
import {
  rsi,
  macd,
  atr,
  stochastic,
  bollinger,
  supertrend,
  sma,
  monthlyVwap,
  getPriceSource,
  type ChartStudies,
} from './studies';

export interface IndicatorSnapshot {
  ema: Record<string, number | null>;
  volume: number | null;
  supertrend: { value: number | null; direction: 1 | -1 } | null;
  bollinger: { upper: number | null; middle: number | null; lower: number | null } | null;
  sma: number | null;
  vwap: number | null;
  macd: { line: number | null; signal: number | null; histogram: number | null } | null;
  rsi: number | null;
  atr: number | null;
  stochastic: { k: number | null; d: number | null } | null;
}

const metricFormatter = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 });

export function formatVolumeValue(volume: number | null): string {
  if (volume === null || !Number.isFinite(volume)) return '-';
  if (volume >= 1e7) return `${metricFormatter.format(volume / 1e7)}Cr`;
  if (volume >= 1e5) return `${metricFormatter.format(volume / 1e5)}L`;
  if (volume >= 1e3) return `${metricFormatter.format(volume / 1e3)}K`;
  return metricFormatter.format(volume);
}

import type { StudyConfigs } from './studyConfigs';

export function computeIndicatorSeries(
  candles: readonly Candle[],
  emaLines: readonly EmaLine[],
  studies: ChartStudies,
  studyConfigs?: StudyConfigs
) {
  const emaMap = new Map<string, (number | null)[]>();
  for (const line of emaLines) {
    emaMap.set(line.id, ema(candles, line.period));
  }

  const macdCfg = studyConfigs?.macd;
  const macdData = studies.macd
    ? macd(candles, macdCfg?.fast ?? 12, macdCfg?.slow ?? 26, macdCfg?.signal ?? 9, macdCfg?.source ?? 'close')
    : null;
  const rsiCfg = studyConfigs?.rsi;
  const rsiData = studies.rsi ? rsi(candles, rsiCfg?.period ?? 14, rsiCfg?.source ?? 'close') : null;
  const atrData = studies.atr ? atr(candles, studyConfigs?.atr?.period ?? 14) : null;
  const stochCfg = studyConfigs?.stochastic;
  const stochData = studies.stochastic
    ? stochastic(candles, stochCfg?.period ?? 14, stochCfg?.dPeriod ?? 3)
    : null;
  const bbCfg = studyConfigs?.bollinger;
  const bbData = studies.bollinger
    ? bollinger(candles, bbCfg?.period ?? 20, bbCfg?.multiplier ?? 2, bbCfg?.source ?? 'close')
    : null;
  const stCfg = studyConfigs?.supertrend;
  const stData = studies.supertrend
    ? supertrend(candles, stCfg?.period ?? 10, stCfg?.multiplier ?? 3)
    : null;
  const smaCfg = studyConfigs?.sma;
  const smaData = studies.sma ? sma(candles.map(b => getPriceSource(b, smaCfg?.source ?? 'close')), smaCfg?.period ?? 50) : null;
  const vwapData = studies.vwap ? monthlyVwap(candles) : null;

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
        supertrend: stData
          ? { value: stData.values[idx] ?? null, direction: stData.directions[idx] ?? 1 }
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
      };
    },
  };
}

/**
 * 60/120fps direct DOM updater for live crosshair inspection
 */
export function updateLiveIndicatorDom(container: HTMLElement, snapshot: IndicatorSnapshot) {
  for (const el of container.querySelectorAll<HTMLElement>('[data-ind-val]')) {
    const key = el.dataset.indVal;
    if (!key) continue;

    if (key.startsWith('ema-')) {
      const id = key.slice(4);
      const val = snapshot.ema[id];
      el.textContent = val !== null && val !== undefined ? val.toFixed(2) : '-';
    } else if (key === 'vol' || key === 'volume-pane') {
      el.textContent = formatVolumeValue(snapshot.volume);
    } else if (key === 'macd-line') {
      const v = snapshot.macd?.line;
      el.textContent = v !== null && v !== undefined ? v.toFixed(2) : '-';
    } else if (key === 'macd-signal') {
      const v = snapshot.macd?.signal;
      el.textContent = v !== null && v !== undefined ? v.toFixed(2) : '-';
    } else if (key === 'macd-hist') {
      const v = snapshot.macd?.histogram;
      if (v !== null && v !== undefined) {
        el.textContent = v.toFixed(2);
        el.style.color = v >= 0 ? '#089981' : '#ef5350';
      } else {
        el.textContent = '-';
      }
    } else if (key === 'rsi') {
      const v = snapshot.rsi;
      el.textContent = v !== null && v !== undefined ? v.toFixed(2) : '-';
    } else if (key === 'atr') {
      const v = snapshot.atr;
      el.textContent = v !== null && v !== undefined ? v.toFixed(2) : '-';
    } else if (key === 'stoch-k') {
      const v = snapshot.stochastic?.k;
      el.textContent = v !== null && v !== undefined ? v.toFixed(2) : '-';
    } else if (key === 'stoch-d') {
      const v = snapshot.stochastic?.d;
      el.textContent = v !== null && v !== undefined ? v.toFixed(2) : '-';
    } else if (key === 'supertrend') {
      const v = snapshot.supertrend?.value;
      if (v !== null && v !== undefined) {
        el.textContent = v.toFixed(2);
        el.style.color = snapshot.supertrend?.direction === 1 ? '#089981' : '#ef5350';
      } else {
        el.textContent = '-';
      }
    } else if (key === 'bb-upper') {
      const v = snapshot.bollinger?.upper;
      el.textContent = v !== null && v !== undefined ? v.toFixed(2) : '-';
    } else if (key === 'bb-mid') {
      const v = snapshot.bollinger?.middle;
      el.textContent = v !== null && v !== undefined ? v.toFixed(2) : '-';
    } else if (key === 'bb-lower') {
      const v = snapshot.bollinger?.lower;
      el.textContent = v !== null && v !== undefined ? v.toFixed(2) : '-';
    } else if (key === 'sma-50') {
      const v = snapshot.sma;
      el.textContent = v !== null && v !== undefined ? v.toFixed(2) : '-';
    } else if (key === 'vwap') {
      const v = snapshot.vwap;
      el.textContent = v !== null && v !== undefined ? v.toFixed(2) : '-';
    }
  }
}
