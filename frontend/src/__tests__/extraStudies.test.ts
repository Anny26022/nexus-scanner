import { describe, expect, it } from 'vitest';
import type { Candle } from '../chart/model';
import {
  EXTRA_STUDY_BY_ID, adx, chaikinMoneyFlow, cci, computeExtraStudies, donchian, keltner, moneyFlowIndex, obv,
  parabolicSar, rateOfChange, relativeStrength, studyParams, studyTitle, williamsR,
} from '../chart/extraStudies';

const day = (index: number) => new Date(Date.UTC(2026, 0, 1 + index)).toISOString().slice(0, 10);
const bar = (index: number, close: number, spread = 1, volume: number | null = 100): Candle =>
  ({date: day(index), open: close, high: close + spread, low: close - spread, close, volume});
const trend = (count: number, start = 100, slope = 1) => Array.from({length: count}, (_, index) => bar(index, start + index * slope));

describe('relative strength', () => {
  it('rebases the price/benchmark ratio to 100 on daily bars', () => {
    const candles = [bar(0, 100), bar(1, 110), bar(2, 121)];
    const benchmark = new Map([[day(0), 1000], [day(1), 1000], [day(2), 1100]]);
    relativeStrength(candles, benchmark).forEach((value, index) => expect(value).toBeCloseTo([100, 110, 110][index], 10));
  });

  it('uses the last benchmark session inside each aggregated bar', () => {
    const weekly = [{...bar(0, 100), date: day(0)}, {...bar(7, 120), date: day(7)}];
    const benchmark = new Map([[day(0), 1000], [day(4), 1000], [day(7), 1200], [day(11), 1000]]);
    expect(relativeStrength(weekly, benchmark)).toEqual([100, 120]);
  });

  it('leaves gaps when the benchmark is missing', () => {
    expect(relativeStrength([bar(0, 100)], undefined)).toEqual([null]);
    expect(relativeStrength([bar(0, 100), bar(1, 100)], new Map([[day(1), 50]]))).toEqual([null, 100]);
  });
});

describe('core indicators', () => {
  it('accumulates on-balance volume', () => {
    expect(obv([bar(0, 10), bar(1, 11, 1, 50), bar(2, 9, 1, 20), bar(3, 9, 1, 40)])).toEqual([0, 50, 30, 30]);
  });

  it('tracks the Donchian high/low window', () => {
    const result = donchian([bar(0, 10), bar(1, 12), bar(2, 8), bar(3, 9)], 3);
    expect(result.upper).toEqual([null, null, 13, 13]);
    expect(result.lower).toEqual([null, null, 7, 7]);
    expect(result.middle).toEqual([null, null, 10, 10]);
  });

  it('computes Williams %R and rate of change exactly', () => {
    const candles = [bar(0, 10, 0), bar(1, 20, 0), bar(2, 15, 0)];
    expect(williamsR(candles, 3)).toEqual([null, null, -50]);
    expect(rateOfChange(candles, 1)).toEqual([null, 100, -25]);
  });

  it('keeps CCI at zero for a flat market and keeps Keltner bands symmetric', () => {
    expect(cci(Array.from({length: 25}, (_, index) => bar(index, 50)), 20).slice(-1)[0]).toBe(0);
    const k = keltner(trend(40), 20, 2, 10);
    const i = 39;
    expect(k.upper[i]! - k.middle[i]!).toBeCloseTo(k.middle[i]! - k.lower[i]!, 10);
  });

  it('reads a steady uptrend as a strong positive trend', () => {
    const result = adx(trend(80), 14);
    expect(result.adx.slice(0, 20).every(value => value === null)).toBe(true);
    expect(result.plusDi.at(-1)!).toBeGreaterThan(result.minusDi.at(-1)!);
    expect(result.adx.at(-1)!).toBeGreaterThan(50);
  });

  it('trails Parabolic SAR below lows in an uptrend', () => {
    const candles = trend(30);
    const sar = parabolicSar(candles);
    expect(sar[0]).toBeNull();
    expect(sar.slice(1).every((value, index) => value! <= candles[index + 1].low)).toBe(true);
  });

  it('pins MFI at 100 with only inflows and CMF at 1 when closing on the high', () => {
    expect(moneyFlowIndex(trend(20), 14).at(-1)).toBe(100);
    expect(chaikinMoneyFlow(Array.from({length: 20}, (_, index) => ({...bar(index, 10), close: 11})), 20).at(-1)).toBe(1);
    expect(moneyFlowIndex([...trend(15).slice(0, 14), bar(14, 120, 1, null)], 14).at(-1)).toBeNull();
  });
});

describe('registry', () => {
  it('clamps parameters and builds legend titles', () => {
    const def = EXTRA_STUDY_BY_ID.get('keltner')!;
    expect(studyParams(def, {enabled: true, params: {period: 9999, multiplier: Number.NaN}})).toEqual({period: 400, multiplier: 2, atrPeriod: 10});
    expect(studyTitle(def, studyParams(def))).toBe('KC 20 2 10');
    expect(studyTitle(EXTRA_STUDY_BY_ID.get('obv')!, {})).toBe('OBV');
  });

  it('computes only enabled studies, keyed by study and line', () => {
    const series = computeExtraStudies(trend(30), {adx: {enabled: true}, obv: {enabled: false}}, {});
    expect([...series.keys()]).toEqual(['adx:adx', 'adx:plusDi', 'adx:minusDi']);
  });
});
