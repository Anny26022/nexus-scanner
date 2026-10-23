import type { Candle } from './model';

/**
 * "Simple Volume with Pocket Pivots" (Nitin Ranjan), reimplemented from the
 * published description (the Pine source is closed):
 *  - blue   pocket pivot: up day whose volume beats every down-day volume of the
 *           previous `ppvLength` bars (5, 10 or 20; default 10)
 *  - green  up day above the `maLength` SMA of volume (default 50)
 *  - red    down day above that SMA
 *  - orange "dry" volume: at or below `dryFraction` of the SMA (default 1/5)
 *  - grey   everything else, which is noise
 * Up and down are close against the previous close. The SMA itself is not drawn.
 * Labels mark the latest highest volume ever/in a year/in a quarter (HVE/HVY/HVQ)
 * and lowest in a year/quarter (LVY/LVQ); a Bull Snort is volume of at least 3x
 * the SMA, a close in the top 35% of the range, and a close above the previous close.
 */
export type SimpleVolumeKind = 'ppv' | 'up' | 'down' | 'dry' | 'noise';

export interface SimpleVolumeOptions {
  ppvLength: number;
  maLength: number;
  dryFraction: number;
  udLength: number;
  snortMultiple: number;
  snortClosePct: number;
}
export const SIMPLE_VOLUME_DEFAULTS: SimpleVolumeOptions = {ppvLength: 10, maLength: 50, dryFraction: 0.2, udLength: 50, snortMultiple: 3, snortClosePct: 35};

export interface VolumeLabel { index: number; text: 'HVE' | 'HVY' | 'HVQ' | 'LVY' | 'LVQ' }

export interface SimpleVolumeResult {
  kinds: (SimpleVolumeKind | null)[];
  average: (number | null)[];
  /** Volume as a percentage of its average. */
  relative: (number | null)[];
  /** Up-day volume over down-day volume across the last `udLength` bars. */
  upDown: (number | null)[];
  snorts: number[];
  labels: VolumeLabel[];
}

/** Bars per quarter and per year, from the typical gap between bars. */
export function periodBars(candles: readonly Candle[]): {quarter: number; year: number} {
  const gaps: number[] = [];
  for (let index = Math.max(1, candles.length - 40); index < candles.length; index++) {
    gaps.push((Date.parse(candles[index].date) - Date.parse(candles[index - 1].date)) / 86_400_000);
  }
  gaps.sort((a, b) => a - b);
  const gap = gaps.length ? gaps[gaps.length >> 1] : 1;
  if (gap >= 20) return {quarter: 3, year: 12};
  if (gap >= 5) return {quarter: 13, year: 52};
  return {quarter: 63, year: 252};
}

export function computeSimpleVolume(candles: readonly Candle[], options: Partial<SimpleVolumeOptions> = {}): SimpleVolumeResult {
  const opts = {...SIMPLE_VOLUME_DEFAULTS, ...options};
  const count = candles.length;
  const kinds: (SimpleVolumeKind | null)[] = new Array(count).fill(null);
  const average: (number | null)[] = new Array(count).fill(null);
  const relative: (number | null)[] = new Array(count).fill(null);
  const upDown: (number | null)[] = new Array(count).fill(null);
  const snorts: number[] = [];
  const direction = candles.map((bar, index) => index === 0 ? 0 : Math.sign(bar.close - candles[index - 1].close));
  const volume = (index: number) => candles[index].volume ?? 0;

  let sum = 0;
  let filled = 0;
  let upSum = 0;
  let downSum = 0;
  for (let index = 0; index < count; index++) {
    // Rolling SMA of volume, including the current bar (as Pine's ta.sma does).
    sum += volume(index);
    filled += 1;
    if (index >= opts.maLength) { sum -= volume(index - opts.maLength); filled -= 1; }
    const avg = filled >= opts.maLength ? sum / opts.maLength : null;
    average[index] = avg;

    if (direction[index] > 0) upSum += volume(index); else if (direction[index] < 0) downSum += volume(index);
    if (index >= opts.udLength) {
      const out = index - opts.udLength;
      if (direction[out] > 0) upSum -= volume(out); else if (direction[out] < 0) downSum -= volume(out);
    }
    upDown[index] = index >= opts.udLength - 1 && downSum > 0 ? upSum / downSum : null;

    const bar = candles[index];
    if (bar.volume === null) continue;
    relative[index] = avg ? bar.volume / avg * 100 : null;

    let highestDown = 0;
    for (let back = Math.max(0, index - opts.ppvLength); back < index; back++) {
      if (direction[back] < 0) highestDown = Math.max(highestDown, volume(back));
    }
    const up = direction[index] > 0;
    const down = direction[index] < 0;
    if (up && index >= opts.ppvLength && bar.volume > highestDown) kinds[index] = 'ppv';
    else if (avg !== null && up && bar.volume > avg) kinds[index] = 'up';
    else if (avg !== null && down && bar.volume > avg) kinds[index] = 'down';
    else if (avg !== null && bar.volume <= avg * opts.dryFraction) kinds[index] = 'dry';
    else kinds[index] = 'noise';

    const range = bar.high - bar.low;
    if (avg !== null && bar.volume >= avg * opts.snortMultiple && up && range > 0 && bar.close >= bar.high - range * opts.snortClosePct / 100) snorts.push(index);
  }

  return {kinds, average, relative, upDown, snorts, labels: extremeLabels(candles)};
}

/** The latest bar that set each record, strongest record first when a bar sets several. */
function extremeLabels(candles: readonly Candle[]): VolumeLabel[] {
  const {quarter, year} = periodBars(candles);
  const latest = new Map<VolumeLabel['text'], number>();
  // About 10 years of history at most, like the original.
  const start = Math.max(0, candles.length - year * 10);
  let ever = -Infinity;
  for (let index = start; index < candles.length; index++) {
    const value = candles[index].volume;
    if (value === null || value <= 0) continue;
    if (value > ever) { ever = value; latest.set('HVE', index); }
    const window = (length: number, pick: (a: number, b: number) => boolean) => {
      if (index - start < length - 1) return false;
      for (let back = index - length + 1; back < index; back++) {
        const other = candles[back].volume;
        if (other !== null && other > 0 && !pick(value, other)) return false;
      }
      return true;
    };
    if (window(year, (a, b) => a > b)) latest.set('HVY', index);
    if (window(quarter, (a, b) => a > b)) latest.set('HVQ', index);
    if (window(year, (a, b) => a < b)) latest.set('LVY', index);
    if (window(quarter, (a, b) => a < b)) latest.set('LVQ', index);
  }
  const labels: VolumeLabel[] = [];
  const used = new Set<number>();
  for (const text of ['HVE', 'HVY', 'HVQ', 'LVY', 'LVQ'] as const) {
    const index = latest.get(text);
    if (index === undefined || used.has(index)) continue;
    used.add(index);
    labels.push({index, text});
  }
  return labels.sort((a, b) => a.index - b.index);
}
