import { expect, it } from 'vitest';
import { computeSimpleVolume, periodBars } from '../chart/simpleVolume';
import type { Candle } from '../chart/model';

const day = (index: number) => new Date(Date.UTC(2024, 0, 1 + index)).toISOString().slice(0, 10);
const bar = (index: number, close: number, volume: number | null, previousClose = close): Candle =>
  ({date: day(index), open: previousClose, high: Math.max(close, previousClose) + 0.1, low: Math.min(close, previousClose) - 0.1, close, volume});

it('marks a pocket pivot only when the up-day volume beats every down day in the previous 10 bars', () => {
  const closes = [10, 9, 10, 9, 10, 9, 10, 9, 10, 9, 10, 11];
  const volumes = [50, 300, 50, 50, 50, 50, 50, 50, 50, 50, 250, 350];
  const candles = closes.map((close, index) => bar(index, close, volumes[index], closes[index - 1]));
  const {kinds} = computeSimpleVolume(candles, {maLength: 50});
  // Bar 10 (250) is up, but bar 1 (300, down) is inside its 10-bar window.
  expect(kinds[10]).toBe('noise');
  // Bar 11 (350) beats every down day in bars 1-10.
  expect(kinds[11]).toBe('ppv');
  // A 5-bar lookback no longer sees bar 1, so bar 10 becomes a pocket pivot.
  expect(computeSimpleVolume(candles, {ppvLength: 5, maLength: 50}).kinds[10]).toBe('ppv');
});

it('uses close against the previous close, a 50-bar SMA, and 1/5 of it for dry volume', () => {
  const candles: Candle[] = [];
  for (let index = 0; index < 50; index++) candles.push(bar(index, 10, 100));
  candles.push(bar(50, 9, 150, 10));   // down, above the average
  candles.push(bar(51, 9.5, 15, 9));   // up but tiny: dry
  candles.push(bar(52, 9.5, 100, 9.5)); // unchanged: noise
  const result = computeSimpleVolume(candles);
  expect(result.average[49]).toBe(100);
  expect(result.kinds[50]).toBe('down');
  expect(result.kinds[51]).toBe('dry');
  expect(result.kinds[52]).toBe('noise');
  expect(result.relative[50]).toBeCloseTo(150 / 101 * 100, 5);
});

it('labels the latest record volumes and spots bull snorts', () => {
  const candles: Candle[] = [];
  for (let index = 0; index < 300; index++) candles.push(bar(index, 10 + (index % 2), 100 + (index % 7), 10 + ((index + 1) % 2)));
  candles[100] = {...candles[100], volume: 5000};
  candles[290] = {...candles[290], volume: 900};
  candles[295] = {...candles[295], volume: 1};
  const close = candles[298].close;
  candles[299] = {date: day(299), open: close, high: close + 1, low: close - 0.2, close: close + 0.9, volume: 2000};
  const result = computeSimpleVolume(candles);
  expect(result.labels).toEqual(expect.arrayContaining([{index: 100, text: 'HVE'}, {index: 299, text: 'HVQ'}, {index: 295, text: 'LVY'}]));
  expect(result.snorts).toContain(299);
  expect(periodBars(candles)).toEqual({quarter: 63, year: 252});
});

it('computes the up/down volume ratio over the lookback', () => {
  const candles = [bar(0, 10, 100), bar(1, 11, 300, 10), bar(2, 10, 100, 11)];
  expect(computeSimpleVolume(candles, {udLength: 2}).upDown[2]).toBe(3);
});

it('keeps defaults for options passed as undefined', () => {
  const candles = Array.from({length: 60}, (_, index) => bar(index, 10, 100));
  expect(computeSimpleVolume(candles, {maLength: undefined, ppvLength: undefined}).average[59]).toBe(100);
});

it('derives TradingView-style volume pills: average traded value, projected RVol and 1-minute liquidity', async () => {
  const { computeIndicatorSeries, formatCrore, formatLakh, formatTimes } = await import('../chart/indicatorValues');
  const { defaultStudies } = await import('../chart/studies');
  // 50 bars at ₹100 with 1,00,00,000 shares: ₹100 Cr traded per day.
  const candles = Array.from({length: 50}, (_, index) => bar(index, 100, 10_000_000));
  const snapshot = computeIndicatorSeries(candles, [], defaultStudies()).getSnapshot(49);
  expect(formatCrore(snapshot.volumeTurnoverAvg)).toBe('100.00 Cr');
  // 1,00,00,000 / 375 minutes × ₹100 = ₹26.67 lakh a minute.
  expect(formatLakh(snapshot.volumeMinuteLiquidity)).toBe('26.67 L');
  expect(formatTimes(160)).toBe('1.6x');
  expect(formatTimes(null)).toBe('-');
});
