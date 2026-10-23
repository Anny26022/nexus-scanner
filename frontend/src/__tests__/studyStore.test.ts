import { expect, it, vi } from 'vitest';
import type { Candle } from '../chart/model';
import { computeStudy, studyKey } from '../chart/studyCompute';
import { EXTRA_STUDIES, studyParams } from '../chart/extraStudies';
import { StudyStore } from '../chart/studyStore';

const candles: Candle[] = Array.from({length: 120}, (_, index) => {
  const close = 100 + 10 * Math.sin(index / 7) + index / 5;
  return {date: new Date(Date.UTC(2026, 0, 1 + index)).toISOString().slice(0, 10), open: close - 1, high: close + 2, low: close - 2, close, volume: 1000 + (index % 9) * 150};
});
const benchmark = new Map(candles.map((bar, index) => [bar.date, 200 + index]));
const keys = [
  studyKey.ema(20), studyKey.rsi(14, 'close'), studyKey.macd(12, 26, 9, 'close'), studyKey.sma(50, 'hl2'), studyKey.bollinger(20, 2, 'close'),
  studyKey.vwap(), studyKey.atr(14), studyKey.stochastic(14, 3), studyKey.supertrend(10, 3),
  ...EXTRA_STUDIES.map(def => studyKey.extra(def.id, studyParams(def))),
];

it('computes every indicator causally, so replay can read a prefix of the full-history result', () => {
  for (const key of keys) {
    const full = computeStudy(key, candles, benchmark);
    for (const cut of [30, 77]) {
      const prefix = computeStudy(key, candles.slice(0, cut), benchmark);
      // Relative strength's last bar reads the newest benchmark close, which on a prefix is a later session;
      // the full-history value is the correct one there, so only earlier bars must agree.
      const compared = key.startsWith('x:rs:') ? cut - 1 : cut;
      for (const [line, values] of Object.entries(prefix)) expect(full[line].slice(0, compared), `${key} ${line}`).toEqual(values.slice(0, compared));
    }
  }
});

it('computes each key once and invalidates only what new inputs change', () => {
  const store = new StudyStore(false);
  store.setInputs(candles, benchmark);
  const listener = vi.fn();
  store.subscribe(listener);
  store.request([studyKey.rsi(14, 'close'), studyKey.extra('rs', studyParams(EXTRA_STUDIES[0]))]);
  const rsi = store.get(studyKey.rsi(14, 'close'));
  expect(rsi?.value).toHaveLength(120);
  expect(listener).toHaveBeenCalledTimes(1);
  store.request([studyKey.rsi(14, 'close')]);
  expect(listener).toHaveBeenCalledTimes(1); // already cached
  store.setInputs(candles, new Map(benchmark));
  expect(store.get(studyKey.rsi(14, 'close'))).toBe(rsi);
  expect(store.get(studyKey.extra('rs', studyParams(EXTRA_STUDIES[0])))).toBeUndefined();
  store.setInputs(candles.slice());
  expect(store.get(studyKey.rsi(14, 'close'))).toBeUndefined();
});

it('computes within a main-thread budget and leaves the rest for the worker', () => {
  const store = new StudyStore();
  store.setInputs(candles);
  // Every clock read advances 7ms, so each computation is charged 7ms of the 12ms budget.
  let clock = 0;
  const now = vi.spyOn(performance, 'now').mockImplementation(() => (clock += 7));
  expect(store.take(studyKey.rsi(14, 'close'))).toBeDefined();
  expect(store.take(studyKey.atr(14))).toBeDefined();
  expect(store.take(studyKey.ema(20))).toBeUndefined(); // budget spent: left for the worker
  expect(store.take(studyKey.rsi(14, 'close'))).toBeDefined(); // cached results are always returned
  clock += 200; // a later burst gets a fresh budget
  expect(store.take(studyKey.ema(20))).toBeDefined();
  now.mockRestore();
});
